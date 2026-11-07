# Núcleo da esteira

Serviço central da esteira de entrega de agentes de IA para múltiplos clientes. Ele recebe eventos dos canais (WhatsApp, e-mail), transforma pedidos em **demandas**, conduz cada demanda por etapas (escopo → construção → QA → produção → operação), pede **aprovação do operador** nos pontos de decisão, aplica **autonomia** e **orçamento** por cliente e agente, e mantém **auditoria** de tudo o que acontece.

Status atual (Plano 1): o núcleo, a API HTTP e o catálogo de serviços estão prontos. O classificador de mensagens (Claude) e a fila Redis entram no Plano 2. Até lá, todo evento recebido cai em `revisao_humana`; nenhuma demanda é criada pela API.

## Requisitos

- Node.js 22
- PostgreSQL 15 ou superior (as migrações usam recursos do 15, como `NULLS NOT DISTINCT`). O `docker-compose.dev.yml` já sobe uma versão compatível.
- Docker (para o Postgres de desenvolvimento)

## Rodando localmente

1. Suba o Postgres de desenvolvimento:

   ```bash
   cd nucleo
   docker compose -f docker-compose.dev.yml up -d
   ```

2. Crie o `.env` a partir do exemplo e troque o token do operador. Ele precisa ter pelo menos 32 caracteres; o serviço não sobe se for menor:

   ```bash
   cp .env.example .env
   sed -i "s/^OPERADOR_TOKEN=.*/OPERADOR_TOKEN=$(openssl rand -hex 32)/" .env
   ```

   Variáveis:

   | Variável | Função |
   | --- | --- |
   | `DATABASE_URL` | Conexão Postgres |
   | `OPERADOR_TOKEN` | Token Bearer de todas as rotas da API (mínimo 32 caracteres) |
   | `PORTA` | Porta HTTP (padrão 3000) |
   | `LOG_LEVEL` | Nível de log JSON (pino): `trace`, `debug`, `info` (padrão), `warn`, `error`, `fatal`. O header `Authorization` nunca é registrado |

3. Instale as dependências e aplique as migrações:

   ```bash
   npm ci
   set -a; . ./.env; set +a      # o código não lê o .env sozinho
   npx drizzle-kit migrate
   ```

   As migrações ficam em `nucleo/drizzle/`. Para gerar uma nova migração depois de alterar `src/db/schema.ts`, use `npm run db:gerar`.

4. Suba o servidor em modo de desenvolvimento (recarrega ao salvar arquivos `.ts`):

   ```bash
   npm run dev
   ```

   O código não lê o `.env` sozinho: as variáveis precisam estar carregadas (`set -a; . ./.env; set +a`) **no mesmo shell** que roda `npm run dev` ou `npm start`. Em um terminal novo, carregue de novo antes de subir.

   Verifique com `curl http://localhost:3000/saude`, que responde `{"ok":true}` sem autenticação.

Outros scripts: `npm test` (suíte com Vitest, usa PGlite em memória, não precisa do Docker), `npm run build` e `npm start` (sem recarga).

## Fluxo de uso com curl

Todas as rotas, exceto `/saude`, exigem `Authorization: Bearer <OPERADOR_TOKEN>`. Os exemplos assumem `jq` instalado.

```bash
export API=http://localhost:3000
export TOKEN='cole-aqui-o-OPERADOR_TOKEN-do-.env'
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

**1. Criar o cliente** (`201`, devolve o cliente com `id`):

```bash
CLIENTE=$(curl -s "${H[@]}" -X POST "$API/clientes" \
  -d '{"nome":"Acme Ltda"}' | jq -r .id)
```

**2. Vincular o canal do cliente** (`204`). O evento é associado ao cliente pelo identificador do canal; canal não vinculado gera `cliente_desconhecido`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "${H[@]}" -X POST "$API/clientes/$CLIENTE/canais" \
  -d '{"tipo":"whatsapp_grupo","identificador":"120363000000000000@g.us"}'
```

Tipos aceitos: `whatsapp_grupo`, `whatsapp_contato`, `email`.

**3. Contratar um serviço do catálogo** (`204`). O `servicoId` é o `id` de um YAML em `catalogo/` (ver abaixo). Serviço inexistente responde `400`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "${H[@]}" -X POST "$API/clientes/$CLIENTE/servicos" \
  -d '{"servicoId":"planilha-dashboard","configuracao":{}}'
```

Para listar os serviços disponíveis: `curl -s "${H[@]}" $API/catalogo`.

**4. Enviar um evento** (`200`). `idExterno` identifica a mensagem de origem, e reenviar a mesma mensagem responde `status: "duplicado"`:

```bash
curl -s "${H[@]}" -X POST "$API/eventos" -d '{
  "canalTipo": "whatsapp_grupo",
  "canalIdentificador": "120363000000000000@g.us",
  "idExterno": "msg-0001",
  "texto": "Quero um dashboard com as vendas do mês",
  "recebidoEm": "2026-11-07T10:00:00-03:00"
}'
```

Resposta esperada até o Plano 2:

```json
{ "eventoId": "…", "status": "revisao_humana" }
```

**5. Conferir aprovações pendentes** (`200`, lista; vazia enquanto não houver demanda):

```bash
curl -s "${H[@]}" $API/aprovacoes
```

**6. Movimentar uma demanda e decidir a aprovação** (quando existir uma demanda, ou seja, a partir do Plano 2). O agente pede a aprovação de escopo; a decisão é sempre do operador:

```bash
DEMANDA=$(curl -s "${H[@]}" "$API/demandas?clienteId=$CLIENTE" | jq -r '.[0].id')

curl -s "${H[@]}" -X POST "$API/demandas/$DEMANDA/acoes" \
  -d '{"acao":"submeter_escopo","agente":"gestor"}'

APROVACAO=$(curl -s "${H[@]}" $API/aprovacoes | jq -r '.[0].id')

curl -s "${H[@]}" -X POST "$API/aprovacoes/$APROVACAO/decisao" \
  -d '{"decisao":"aprovar","comentario":"Escopo confirmado"}'
```

Ações de agente aceitas em `/demandas/:id/acoes`: `submeter_escopo`, `concluir_construcao`, `qa_aprovado`, `qa_reprovado`, `producao_ok`, `producao_falhou` e `escalar` (exige `motivo`). Aprovar, recusar, retomar, cancelar e a decisão de aprovações são exclusivos do operador. Ação fora de ordem responde `409`.

`GET /aprovacoes` mostra o fato exato a aprovar: cada item traz `detalhes` como gravado (`{ferramenta, argumentos}` em aprovações do tipo `acao`; `{motivo}` em `escalada`) e a `etapa` atual da demanda.

**Cancelar uma demanda** (ação do operador, `200` com o novo estado). Fecha como recusadas as aprovações pendentes da demanda. Demanda inexistente responde `404`; já cancelada, `409`:

```bash
curl -s "${H[@]}" -X POST "$API/demandas/$DEMANDA/cancelar" \
  -d '{"motivo":"Cliente desistiu do pedido"}'
```

Outras rotas úteis: `GET /clientes`, `GET /demandas`, `GET /auditoria?alvoId=…&limite=100`, `PUT /clientes/:id/servicos/:servicoId/autonomia`, `POST /politica/autorizar`, `POST /execucoes` (com `/consumo` e `/fim`).

## Segurança operacional

- **Mantenha a API atrás da VPN.** Ela não deve ser exposta na internet pública. Hoje a única barreira é o token do operador: quem o possui age como operador.
- **Token com no mínimo 32 caracteres**, gerado aleatoriamente (`openssl rand -hex 32`), guardado fora do repositório (o `.env` já está no `.gitignore`).
- **Pausa de emergência:** `POST /pausas` com `escopo` (`global`, `cliente` ou `agente`), `alvo` (UUID do cliente, ou nome do agente; ausente em `global`) e `motivo`. Enquanto a pausa estiver ativa, ações de agentes no escopo recebem `423`, e eventos em pausa caem em `revisao_humana`. Ações do operador continuam permitidas. Para retomar: `DELETE /pausas/:id`.

## Adicionando um serviço ao catálogo

Serviços são arquivos YAML em `nucleo/catalogo/`. Para adicionar um, crie um novo arquivo; não é preciso alterar código. Exemplo, `catalogo/exemplo.yaml`:

```yaml
id: exemplo
nome: Exemplo de serviço
entradas_escopo:
  - arquivo de origem
  - indicadores desejados
construtor: agente-dados-bi        # agente-dados-bi | agente-validacao | agente-dev
repo_modelo: modelos/exemplo       # ou null
testes_qa_extras:
  - conferencia_totais_com_origem
publicacao: container-web          # container-web | rotina | definida-no-escopo
rotinas_operacao:
  - atualizar_dados
```

Regras, verificadas na carga do catálogo (o serviço não sobe se alguma regra falhar):

- Todos os campos são obrigatórios. Use `repo_modelo: null` e listas vazias quando não se aplicarem.
- `id` deve ser único entre os arquivos. O arquivo `sob-medida.yaml` é obrigatório.
- Arquivos com YAML inválido ou campos fora do formato impedem a inicialização, com a mensagem indicando o arquivo e o campo.

Depois de criar ou alterar o arquivo, reinicie o serviço e confira em `GET /catalogo`. O catálogo é lido só na inicialização; `npm run dev` recarrega ao salvar código `.ts`, não ao alterar YAML.

## Testes e CI

- Local: `cd nucleo && npm ci && npx tsc --noEmit && npm test`.
- GitHub Actions: `.github/workflows/nucleo.yml` roda essas três etapas em Node 22 a cada push e pull request que altere `nucleo/**` ou o próprio workflow. Um segundo job sobe `postgres:16`, aplica as migrações com `npx drizzle-kit migrate` e roda o smoke test `test/integracao/postgres.smoke.test.ts` (cliente → demanda → aprovação de escopo em Postgres real).
- Smoke test local contra um Postgres já migrado: `DATABASE_URL_TESTE_PG=$DATABASE_URL npx vitest run test/integracao`. Sem a variável, o teste é pulado.

## Estrutura

| Pasta | Conteúdo |
| --- | --- |
| `src/api/` | Rotas HTTP (Fastify) e autenticação por token |
| `src/esteira/` | Máquina de estados das demandas e serviço de aprovações |
| `src/eventos/` | Ingestão de eventos e classificador (interface; implementação no Plano 2) |
| `src/clientes/` | Clientes, canais e serviços contratados |
| `src/seguranca/` | Autonomia, pausas, orçamento de execuções e política de ferramentas |
| `src/db/` | Schema Drizzle e conexão |
| `catalogo/` | Catálogo de serviços (YAML) |
| `config/` | Permissões de agentes × ferramentas |
| `drizzle/` | Migrações SQL |
