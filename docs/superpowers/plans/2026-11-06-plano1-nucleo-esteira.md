# Plano 1 — Núcleo da Esteira — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serviço TypeScript que cadastra clientes e canais, carrega o catálogo de serviços, ingere eventos, cria demandas e as move pela esteira (com aprovações do operador, limite de 3 tentativas de QA, escalonamento e auditoria imutável), exposto por uma API HTTP.

**Architecture:** Um único pacote `nucleo/` em Node.js/TypeScript. Regras da esteira ficam numa máquina de estados pura (`esteira/maquina.ts`), sem I/O; um serviço (`esteira/servico.ts`) aplica as transições no Postgres dentro de transações e registra auditoria. A triagem por IA entra por uma interface `Classificador` (implementação real com Claude fica no Plano 2). A API (Fastify) é a porta que o painel (Plano 3) e os canais (Plano 2) usarão.

**Tech Stack:** Node.js 22, TypeScript (strict), Drizzle ORM + drizzle-kit, Postgres 16 (produção) / PGlite (testes, em processo), Fastify 5, Zod, `yaml`, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-plataforma-agentes-fase1-design.md`

## Global Constraints

- Nenhuma regra específica de cliente no código: tudo que é por cliente vive em tabelas ou no catálogo (spec §2.1).
- Máximo de **3 tentativas** de QA; na 3ª reprovação a demanda vai para `escalada` (spec §4).
- Aprovar/recusar/retomar/cancelar: **somente o ator `operador`** (spec §2.3).
- Limiar de confiança da triagem: **0.8**; abaixo disso → `revisao_humana`, sem criar demanda (spec §2.4, §10).
- Credenciais nunca no Postgres; `clientes.cofre_ref` guarda só a referência (spec §8).
- Tabela `auditoria` é somente inserção — UPDATE/DELETE devem falhar no banco (spec §11).
- API exige `Authorization: Bearer <OPERADOR_TOKEN>` em todas as rotas exceto `GET /saude` (defesa em profundidade além da VPN).
- Identificadores em português (domínio), código em TypeScript strict, sem `any`.
- Compatível com GitHub Free: CI em `ubuntu-latest` agora; runner self-hosted vem no Plano 6.

## Review Focus

1. **Evento entregue duas vezes** (webhooks de WhatsApp/e-mail reenviam) → um único evento e uma única demanda; segunda chamada retorna `status: 'duplicado'`. Teste na Task 6.
2. **Mesmo canal cadastrado para dois clientes** (ex.: grupo de WhatsApp) → cadastro recusado com erro claro, para a triagem nunca ficar ambígua. Teste na Task 3.
3. **Decisão dupla na mesma aprovação** (duplo clique no painel) → segunda decisão rejeitada (HTTP 409) e a demanda transiciona uma vez só. Teste na Task 5 e na Task 7.
4. **Ação fora de hora** (ex.: `qa_aprovado` com a demanda em `escopo`) → erro `TransicaoInvalida`, nada muda no banco. Teste na Task 4 e na Task 5.
5. **Catálogo YAML inválido** (campo faltando, `id` duplicado) → o serviço não sobe e a mensagem nomeia o arquivo e o campo. Teste na Task 2.

---

## Estrutura de arquivos

```
nucleo/
  package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts  .env.example
  docker-compose.dev.yml            # Postgres 16 local
  catalogo/
    planilha-dashboard.yaml  validacao-conciliacao.yaml  sob-medida.yaml
  drizzle/                          # migrações geradas + custom (auditoria imutável)
  src/
    db/schema.ts                    # todas as tabelas
    db/cliente.ts                   # criarDb(url), criarDbTeste()
    auditoria/registrar.ts
    catalogo/carregar.ts
    clientes/repositorio.ts
    esteira/maquina.ts              # pura
    esteira/servico.ts              # transações + aprovações + auditoria
    eventos/ingestao.ts
    eventos/classificador.ts        # interface + tipos
    api/app.ts                      # Fastify
    principal.ts                    # entrypoint
  test/                             # espelha src/
.github/workflows/nucleo.yml
```

---

### Task 1: Projeto, schema do banco e auditoria imutável

**Files:**
- Create: `nucleo/package.json`, `nucleo/tsconfig.json`, `nucleo/vitest.config.ts`, `nucleo/drizzle.config.ts`, `nucleo/.env.example`, `nucleo/docker-compose.dev.yml`
- Create: `nucleo/src/db/schema.ts`, `nucleo/src/db/cliente.ts`, `nucleo/src/auditoria/registrar.ts`
- Create: `nucleo/drizzle/*` (gerado) + migração custom `auditoria_imutavel`
- Test: `nucleo/test/db/schema.test.ts`, `nucleo/test/auditoria/registrar.test.ts`

**Interfaces:**
- Produces:
  - `type Db` (Drizzle sobre `pg` ou PGlite — mesmo tipo para o resto do código)
  - `criarDb(url: string): Db` — produção, `pg` Pool
  - `criarDbTeste(): Promise<Db>` — PGlite em memória com todas as migrações aplicadas
  - Tabelas (snake_case no banco, camelCase no TS), todas com `id uuid default gen_random_uuid()` e `criado_em timestamptz default now()`:
    - `clientes(nome text not null, contatos jsonb default '[]', status text default 'ativo', cofre_ref text)`
    - `canais_cliente(cliente_id → clientes, tipo text check in ('whatsapp_grupo','whatsapp_contato','email'), identificador text)` + `unique(tipo, identificador)`
    - `servicos_contratados(cliente_id, servico_id text, configuracao jsonb default '{}')` + `unique(cliente_id, servico_id)`
    - `eventos(canal_tipo, canal_identificador, id_externo text, texto text, recebido_em timestamptz, cliente_id null, servico_id null, confianca real null, resumo text null, status text)` + `unique(canal_tipo, id_externo)`
    - `demandas(cliente_id, servico_id text, evento_id null, etapa text, tentativas_qa int default 0, titulo text, atualizado_em timestamptz)`
    - `escopos(demanda_id, versao int, conteudo jsonb, status text)`
    - `entregas(demanda_id, repositorio text, versao text, ambiente text check in ('staging','producao'), url text, status text)`
    - `relatorios_qa(demanda_id, portao int check in (1,2,3), aprovado boolean, evidencias jsonb)`
    - `validacoes(cliente_id, evento_id null, campos jsonb, valor_declarado numeric null, valor_sistema numeric null, status text check in ('confere','divergente','nao_encontrado','pendente_verificacao','revisao_humana'))`
    - `aprovacoes(demanda_id, tipo text check in ('escopo','entrega','escalada'), status text default 'pendente' check in ('pendente','aprovada','recusada'), comentario text null, decidido_em timestamptz null)`
    - `rotinas(cliente_id, entrega_id null, tipo text, cron text, ultima_execucao timestamptz null, ultimo_resultado text null)`
    - `auditoria(ator text, acao text, alvo_tipo text, alvo_id uuid null, detalhes jsonb default '{}', credencial_ref text null)`
  - `registrarAuditoria(db: Db | Tx, e: { ator: string; acao: string; alvoTipo: string; alvoId?: string; detalhes?: Record<string, unknown>; credencialRef?: string }): Promise<void>`
  - `type Tx` = transação Drizzle (aceita onde `Db` é aceito para escrita)

- [ ] **Step 1:** Criar o projeto: `npm init` em `nucleo/`, `"type": "module"`, scripts `test` (`vitest run`), `build` (`tsc`), `db:gerar` (`drizzle-kit generate`), `dev` (`tsx watch src/principal.ts`). Dependências: `drizzle-orm pg @electric-sql/pglite fastify zod yaml`; dev: `typescript tsx vitest drizzle-kit @types/pg @types/node`. `tsconfig` strict, `module`/`moduleResolution` `NodeNext`, target `ES2022`.

- [ ] **Step 2: Write the failing test** `test/db/schema.test.ts`

```ts
it('canal não pode pertencer a dois clientes', async () => {
  const db = await criarDbTeste();
  const [a] = await db.insert(clientes).values({ nome: 'A' }).returning();
  const [b] = await db.insert(clientes).values({ nome: 'B' }).returning();
  await db.insert(canaisCliente).values({ clienteId: a.id, tipo: 'whatsapp_grupo', identificador: 'g1' });
  await expect(db.insert(canaisCliente).values({ clienteId: b.id, tipo: 'whatsapp_grupo', identificador: 'g1' })).rejects.toThrow();
});
it('auditoria rejeita UPDATE e DELETE', async () => {
  const db = await criarDbTeste();
  await registrarAuditoria(db, { ator: 'operador', acao: 'teste', alvoTipo: 'nada' });
  await expect(db.update(auditoria).set({ acao: 'x' })).rejects.toThrow(/somente inser/);
  await expect(db.delete(auditoria)).rejects.toThrow(/somente inser/);
});
it('evento duplicado (mesmo canal_tipo + id_externo) é rejeitado pelo banco', async () => { /* insere 2x, segunda rejeita */ });
```

- [ ] **Step 3:** Run `npm test -- test/db` → FAIL (módulos não existem).

- [ ] **Step 4:** Implementar `schema.ts`, `cliente.ts` (`criarDbTeste` usa `drizzle-orm/pglite` + `migrate` de `drizzle-orm/pglite/migrator` apontando para `./drizzle`), `registrar.ts`. Rodar `npm run db:gerar`. Criar migração custom com `npx drizzle-kit generate --custom --name auditoria_imutavel` contendo uma função PL/pgSQL que faz `RAISE EXCEPTION 'auditoria é somente inserção'` e triggers `BEFORE UPDATE` e `BEFORE DELETE` em `auditoria`.

- [ ] **Step 5:** Run `npm test -- test/db test/auditoria` → PASS.

- [ ] **Step 6:** `docker-compose.dev.yml` com `postgres:16` (porta 5432, volume nomeado) e `.env.example` com `DATABASE_URL`, `OPERADOR_TOKEN`, `PORTA=3000`. Verificar: `docker compose -f nucleo/docker-compose.dev.yml up -d` sobe e `npx drizzle-kit migrate` aplica sem erro (pular se Docker indisponível e anotar no commit).

- [ ] **Step 7: Commit** `feat(nucleo): projeto, schema e auditoria imutável`

---

### Task 2: Catálogo de serviços

**Files:**
- Create: `nucleo/src/catalogo/carregar.ts`, `nucleo/catalogo/{planilha-dashboard,validacao-conciliacao,sob-medida}.yaml`
- Test: `nucleo/test/catalogo/carregar.test.ts` (+ fixtures em `nucleo/test/catalogo/fixtures/`)

**Interfaces:**
- Produces:
  - `type ModeloServico = { id: string; nome: string; entradasEscopo: string[]; construtor: 'agente-dados-bi' | 'agente-validacao' | 'agente-dev'; repoModelo: string | null; testesQaExtras: string[]; publicacao: 'container-web' | 'rotina' | 'definida-no-escopo'; rotinasOperacao: string[] }`
  - `type Catalogo = { obter(id: string): ModeloServico | undefined; listar(): ModeloServico[]; ids(): string[] }`
  - `carregarCatalogo(diretorio: string): Promise<Catalogo>` — lança `ErroCatalogo` (mensagem contém nome do arquivo e caminho do campo inválido)
  - Constante `SERVICO_SOB_MEDIDA = 'sob-medida'`

YAML em snake_case (`entradas_escopo`, …) convertido para camelCase pelo schema Zod. Conteúdo dos 3 arquivos conforme spec §7.1: `planilha-dashboard` (construtor `agente-dados-bi`, testes `conferencia_totais_com_origem`, `filtros_retornam_subconjunto_correto`, `acesso_somente_autenticado`, publicação `container-web`, rotina `atualizar_dados`); `validacao-conciliacao` (construtor `agente-validacao`, testes `acerto_conjunto_rotulado_min_98`, publicação `rotina`, rotina `validar_eventos`); `sob-medida` (construtor `agente-dev`, `repo_modelo: null`, publicação `definida-no-escopo`).

- [ ] **Step 1: Write the failing tests**

```ts
it('carrega os 3 serviços reais', async () => {
  const c = await carregarCatalogo('catalogo');
  expect(c.ids().sort()).toEqual(['planilha-dashboard', 'sob-medida', 'validacao-conciliacao']);
  expect(c.obter('validacao-conciliacao')?.testesQaExtras).toContain('acerto_conjunto_rotulado_min_98');
});
it('falha nomeando arquivo e campo quando falta construtor', async () => {
  await expect(carregarCatalogo('test/catalogo/fixtures/sem-construtor'))
    .rejects.toThrow(/sem-construtor\.yaml.*construtor/);
});
it('falha com id duplicado', async () => {
  await expect(carregarCatalogo('test/catalogo/fixtures/duplicado')).rejects.toThrow(/id duplicado.*planilha-dashboard/);
});
it('falha se não existir o serviço sob-medida', async () => { /* fixture sem sob-medida → /sob-medida/ */ });
```

- [ ] **Step 2:** Run `npm test -- test/catalogo` → FAIL.
- [ ] **Step 3:** Implementar `carregarCatalogo` (lê `*.yaml` do diretório, valida cada um com Zod, agrega erros com nome do arquivo + `issue.path.join('.')`, checa ids únicos e presença de `sob-medida`) e os 3 YAMLs.
- [ ] **Step 4:** Run `npm test -- test/catalogo` → PASS.
- [ ] **Step 5: Commit** `feat(nucleo): catálogo de serviços plugável`

---

### Task 3: Clientes e canais

**Files:**
- Create: `nucleo/src/clientes/repositorio.ts`
- Test: `nucleo/test/clientes/repositorio.test.ts`

**Interfaces:**
- Consumes: `Db`, tabelas `clientes`, `canaisCliente`, `servicosContratados`, `registrarAuditoria` (Task 1)
- Produces:
  - `type TipoCanal = 'whatsapp_grupo' | 'whatsapp_contato' | 'email'`
  - `criarCliente(db, dados: { nome: string; contatos?: unknown[]; cofreRef?: string }, ator: string): Promise<{ id: string }>`
  - `vincularCanal(db, clienteId: string, canal: { tipo: TipoCanal; identificador: string }, ator: string): Promise<void>` — lança `CanalJaVinculado` (com `clienteIdAtual`) se o canal pertence a outro cliente; idempotente se já é do mesmo cliente
  - `contratarServico(db, clienteId, servicoId: string, configuracao: Record<string, unknown>, catalogo: Catalogo, ator): Promise<void>` — lança `ServicoInexistente` se `servicoId` não está no catálogo
  - `resolverClientePorCanal(db, tipo: TipoCanal, identificador: string): Promise<{ id: string; nome: string; servicosContratados: string[] } | null>`
  - `listarClientes(db): Promise<Array<{ id: string; nome: string; status: string }>>`
  - E-mail: `identificador` normalizado para minúsculas e sem espaços antes de gravar e de resolver.

- [ ] **Step 1: Write the failing tests**

```ts
it('resolve cliente pelo grupo de WhatsApp', async () => { /* criarCliente Fiore, vincularCanal g1, resolver → nome 'Fiore' */ });
it('recusa canal já vinculado a outro cliente', async () => {
  await expect(vincularCanal(db, b.id, { tipo: 'whatsapp_grupo', identificador: 'g1' }, 'operador'))
    .rejects.toBeInstanceOf(CanalJaVinculado);
});
it('vincular o mesmo canal ao mesmo cliente é idempotente', async () => { /* 2x sem erro */ });
it('e-mail é resolvido sem diferenciar maiúsculas', async () => { /* vincula 'Financeiro@Fiore.com' , resolve 'financeiro@fiore.com' */ });
it('canal desconhecido → null', async () => {});
it('cada operação grava auditoria', async () => { /* conta linhas em auditoria com acao 'cliente.criado','canal.vinculado' */ });
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(nucleo): cadastro de clientes e canais`

---

### Task 4: Máquina de estados da esteira (pura)

**Files:**
- Create: `nucleo/src/esteira/maquina.ts`
- Test: `nucleo/test/esteira/maquina.test.ts`

**Interfaces:**
- Produces:
  - `type Etapa = 'escopo' | 'aguardando_aprovacao_escopo' | 'construcao' | 'qa' | 'aguardando_aprovacao_entrega' | 'producao' | 'operacao' | 'escalada' | 'cancelada'`
  - `type Acao = 'submeter_escopo' | 'aprovar' | 'recusar' | 'concluir_construcao' | 'qa_aprovado' | 'qa_reprovado' | 'producao_ok' | 'producao_falhou' | 'retomar' | 'cancelar'`
  - `type Ator = { tipo: 'operador' } | { tipo: 'agente'; nome: string }`
  - `type EstadoDemanda = { etapa: Etapa; tentativasQa: number }`
  - `type Resultado = EstadoDemanda & { abrirAprovacao?: 'escopo' | 'entrega' | 'escalada'; motivo?: string }`
  - `transicionar(estado: EstadoDemanda, acao: Acao, ator: Ator): Resultado` — lança `TransicaoInvalida` ou `AtorNaoAutorizado`
  - `const MAX_TENTATIVAS_QA = 3`
  - `const ACOES_DO_OPERADOR: ReadonlySet<Acao> = new Set(['aprovar','recusar','retomar','cancelar'])`

Tabela de transições (todas as demais combinações → `TransicaoInvalida`; `cancelar` vale de qualquer etapa exceto `cancelada`):

| De | Ação | Para | Extra |
|----|------|------|-------|
| escopo | submeter_escopo | aguardando_aprovacao_escopo | abrirAprovacao `escopo` |
| aguardando_aprovacao_escopo | aprovar | construcao | |
| aguardando_aprovacao_escopo | recusar | escopo | |
| construcao | concluir_construcao | qa | |
| qa | qa_aprovado | aguardando_aprovacao_entrega | abrirAprovacao `entrega` |
| qa | qa_reprovado | construcao, tentativas+1 | se tentativas+1 ≥ 3 → `escalada`, abrirAprovacao `escalada`, motivo `limite_tentativas_qa` |
| aguardando_aprovacao_entrega | aprovar | producao | |
| aguardando_aprovacao_entrega | recusar | construcao | (não conta tentativa de QA) |
| producao | producao_ok | operacao | |
| producao | producao_falhou | escalada | abrirAprovacao `escalada`, motivo `falha_producao_revertida` |
| escalada | retomar | construcao, tentativas = 0 | |

- [ ] **Step 1: Write the failing tests** — um `it.each` cobrindo cada linha da tabela, mais:

```ts
it('3ª reprovação no QA escala', () => {
  const r = transicionar({ etapa: 'qa', tentativasQa: 2 }, 'qa_reprovado', agente);
  expect(r).toEqual({ etapa: 'escalada', tentativasQa: 3, abrirAprovacao: 'escalada', motivo: 'limite_tentativas_qa' });
});
it('2ª reprovação volta para construção', () => {
  expect(transicionar({ etapa: 'qa', tentativasQa: 1 }, 'qa_reprovado', agente)).toEqual({ etapa: 'construcao', tentativasQa: 2 });
});
it('agente não pode aprovar', () => {
  expect(() => transicionar({ etapa: 'aguardando_aprovacao_entrega', tentativasQa: 0 }, 'aprovar', agente)).toThrow(AtorNaoAutorizado);
});
it('ação fora de hora é inválida', () => {
  expect(() => transicionar({ etapa: 'escopo', tentativasQa: 0 }, 'qa_aprovado', agente)).toThrow(TransicaoInvalida);
});
it('nada sai de cancelada', () => { /* retomar/cancelar em cancelada → TransicaoInvalida */ });
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar como tabela de dados + função (verificar `ACOES_DO_OPERADOR` antes da tabela). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(nucleo): máquina de estados da esteira`

---

### Task 5: Serviço da esteira (persistência, aprovações, escalonamento)

**Files:**
- Create: `nucleo/src/esteira/servico.ts`
- Test: `nucleo/test/esteira/servico.test.ts`

**Interfaces:**
- Consumes: `transicionar`, `Ator`, `Acao` (Task 4); `Db`, tabelas, `registrarAuditoria` (Task 1); `SERVICO_SOB_MEDIDA` (Task 2)
- Produces:
  - `criarDemanda(db, d: { clienteId: string; servicoId: string; titulo: string; eventoId?: string }, ator: Ator): Promise<{ id: string }>` — etapa inicial `escopo`
  - `executarAcao(db, demandaId: string, acao: Exclude<Acao, 'aprovar'|'recusar'|'retomar'>, ator: Ator): Promise<EstadoDemanda>` — ações de agentes e `cancelar`
  - `decidirAprovacao(db, aprovacaoId: string, decisao: 'aprovar' | 'recusar', comentario: string | null): Promise<EstadoDemanda>` — sempre com ator operador. Mapeia: aprovação `escopo`/`entrega` → ação `aprovar`/`recusar`; `escalada` → `retomar`/`cancelar`. Lança `AprovacaoJaDecidida` se status ≠ `pendente`.
  - `listarAprovacoesPendentes(db): Promise<Array<{ id; tipo; demandaId; clienteNome; tituloDemanda; criadoEm }>>`
  - `listarDemandas(db, filtro: { clienteId?: string }): Promise<Array<{ id; clienteId; servicoId; titulo; etapa; tentativasQa }>>`
  - Nome do ator na auditoria: `'operador'` ou `'agente:<nome>'`. Ações: `demanda.criada`, `demanda.transicao` (detalhes `{de, para, acao, motivo?}`), `aprovacao.aberta`, `aprovacao.decidida`.

Comportamento:
- Cada chamada roda numa transação; a linha da demanda é lida com `SELECT … FOR UPDATE`; a aprovação com `FOR UPDATE` e checagem de `pendente` — garante a Review Focus #3.
- Quando `Resultado.abrirAprovacao` vem preenchido, insere uma linha em `aprovacoes` (pendente).
- `producao_falhou`: além de escalar, cria nova demanda `sob-medida` para o mesmo cliente com título `Investigar falha em produção: <título original>`.
- Qualquer erro → rollback; estado e auditoria inalterados.

- [ ] **Step 1: Write the failing tests**

```ts
it('fluxo feliz até operação abre e fecha 2 aprovações', async () => {
  // criarDemanda → submeter_escopo → decidir(escopo, aprovar) → concluir_construcao
  // → qa_aprovado → decidir(entrega, aprovar) → producao_ok
  expect(estado.etapa).toBe('operacao');
  expect(await contarAprovacoes(db, d.id, 'aprovada')).toBe(2);
});
it('3 reprovações de QA escalam e abrem aprovação de escalada', async () => {});
it('decidir escalada com aprovar retoma em construção com tentativas zeradas', async () => {});
it('decisão dupla na mesma aprovação: segunda lança AprovacaoJaDecidida e não transiciona de novo', async () => {
  await decidirAprovacao(db, ap.id, 'aprovar', null);
  await expect(decidirAprovacao(db, ap.id, 'aprovar', null)).rejects.toBeInstanceOf(AprovacaoJaDecidida);
  expect((await obterDemanda(db, d.id)).etapa).toBe('construcao');
});
it('decisões concorrentes: apenas uma vence', async () => {
  const r = await Promise.allSettled([decidirAprovacao(db, ap.id, 'aprovar', null), decidirAprovacao(db, ap.id, 'recusar', null)]);
  expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
});
it('ação inválida não altera banco nem auditoria', async () => {
  const antes = await contarAuditoria(db);
  await expect(executarAcao(db, d.id, 'qa_aprovado', agente)).rejects.toBeInstanceOf(TransicaoInvalida);
  expect(await contarAuditoria(db)).toBe(antes);
});
it('falha em produção escala e cria demanda de investigação sob-medida', async () => {});
it('listarDemandas filtra por cliente (não vaza demandas de outro cliente)', async () => {});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(nucleo): serviço da esteira com aprovações e escalonamento`

---

### Task 6: Ingestão de eventos e triagem

**Files:**
- Create: `nucleo/src/eventos/classificador.ts`, `nucleo/src/eventos/ingestao.ts`
- Test: `nucleo/test/eventos/ingestao.test.ts`

**Interfaces:**
- Consumes: `resolverClientePorCanal` (Task 3), `Catalogo` (Task 2), `criarDemanda` (Task 5), `registrarAuditoria`
- Produces:
  - `type Classificacao = { servicoId: string | 'ignorar'; confianca: number; resumo: string; titulo: string }`
  - `interface Classificador { classificar(e: { texto: string; clienteNome: string; servicosContratados: string[]; servicosCatalogo: ModeloServico[] }): Promise<Classificacao> }`
  - `const LIMIAR_CONFIANCA = 0.8`
  - `type EntradaEvento = { canalTipo: TipoCanal; canalIdentificador: string; idExterno: string; texto: string; recebidoEm: Date }`
  - `type StatusIngestao = 'demanda_criada' | 'revisao_humana' | 'cliente_desconhecido' | 'ignorado' | 'duplicado'`
  - `ingerirEvento(db, deps: { classificador: Classificador; catalogo: Catalogo }, e: EntradaEvento): Promise<{ eventoId: string; status: StatusIngestao; demandaId?: string }>`

Regras, em ordem:
1. Já existe evento com `(canalTipo, idExterno)` → retorna `{ eventoId existente, status: 'duplicado' }` sem chamar o classificador (tratar violação de unique na inserção, não só checagem prévia).
2. Grava o evento; cliente não resolvido → `cliente_desconhecido` (não chama classificador).
3. Chama o classificador. Se lançar erro → `revisao_humana` com `resumo: 'falha na classificação: <mensagem>'` (o evento nunca se perde).
4. `servicoId === 'ignorar'` com confiança ≥ 0.8 → `ignorado`.
5. Confiança < 0.8, ou `servicoId` fora do catálogo → `revisao_humana`.
6. Caso contrário → `criarDemanda` com ator `{ tipo: 'agente', nome: 'gestor' }` → `demanda_criada`.
- O evento grava `clienteId`, `servicoId`, `confianca`, `resumo`, `status` finais.

- [ ] **Step 1: Write the failing tests** — com `ClassificadorFake` (retorno configurável + contador de chamadas):

```ts
it('evento do grupo da Fiore classificado vira demanda', async () => {});
it('mesmo idExterno duas vezes → uma demanda, segunda retorna duplicado e não chama classificador', async () => {
  const r1 = await ingerirEvento(db, deps, e); const r2 = await ingerirEvento(db, deps, e);
  expect(r2).toEqual({ eventoId: r1.eventoId, status: 'duplicado' });
  expect(fake.chamadas).toBe(1);
  expect(await listarDemandas(db, {})).toHaveLength(1);
});
it('confiança 0.79 → revisao_humana, sem demanda', async () => {});
it('confiança exatamente 0.8 → demanda', async () => {});
it('canal desconhecido → cliente_desconhecido, classificador não chamado', async () => {});
it('classificador lança erro → revisao_humana e evento salvo', async () => {});
it('servicoId inexistente no catálogo → revisao_humana', async () => {});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(nucleo): ingestão de eventos com triagem`

---

### Task 7: API HTTP

**Files:**
- Create: `nucleo/src/api/app.ts`, `nucleo/src/principal.ts`
- Test: `nucleo/test/api/app.test.ts`

**Interfaces:**
- Consumes: tudo das Tasks 2–6
- Produces: `construirApp(deps: { db: Db; catalogo: Catalogo; classificador: Classificador; operadorToken: string }): FastifyInstance`

Rotas (corpo validado com Zod; erro de validação → 400 com lista de campos):

| Método e rota | Corpo / query | Resposta |
|---|---|---|
| `GET /saude` (sem auth) | — | `200 {ok:true}` |
| `POST /clientes` | `{nome, contatos?, cofreRef?}` | `201 {id}` |
| `GET /clientes` | — | `200 [..]` |
| `POST /clientes/:id/canais` | `{tipo, identificador}` | `204`; `CanalJaVinculado` → `409` |
| `POST /clientes/:id/servicos` | `{servicoId, configuracao?}` | `204`; `ServicoInexistente` → `400` |
| `GET /catalogo` | — | `200 ModeloServico[]` |
| `POST /eventos` | `EntradaEvento` (`recebidoEm` ISO) | `200 {eventoId, status, demandaId?}` |
| `GET /demandas` | `?clienteId` | `200 [..]` |
| `POST /demandas/:id/acoes` | `{acao, agente}` | `200 EstadoDemanda`; `TransicaoInvalida` → `409`; `AtorNaoAutorizado` → `403` |
| `GET /aprovacoes` | — | `200` pendentes |
| `POST /aprovacoes/:id/decisao` | `{decisao: 'aprovar'\|'recusar', comentario?}` | `200 EstadoDemanda`; `AprovacaoJaDecidida` → `409` |
| `GET /auditoria` | `?alvoId&limite` (padrão 100, máx 500) | `200 [..]` mais recentes primeiro |

- Sem `Authorization: Bearer <token>` correto → `401` (comparação em tempo constante com `crypto.timingSafeEqual`).
- `POST /demandas/:id/acoes` rejeita `aprovar|recusar|retomar` com `400` (essas só por `/aprovacoes`).
- `principal.ts`: lê `DATABASE_URL`, `OPERADOR_TOKEN` (falha ao subir se ausente ou < 32 caracteres), `PORTA`; carrega catálogo de `./catalogo`; usa um `ClassificadorIndisponivel` que sempre lança (eventos caem em `revisao_humana` até o Plano 2).

- [ ] **Step 1: Write the failing tests** (via `app.inject`, banco PGlite)

```ts
it('sem token → 401; GET /saude sem token → 200', async () => {});
it('fluxo: cria cliente, vincula canal, POST /eventos cria demanda, decisão via /aprovacoes', async () => {});
it('canal duplicado em outro cliente → 409', async () => {});
it('decisão dupla → 409 na segunda', async () => {});
it('ação de operador em /demandas/:id/acoes → 400', async () => {});
it('corpo inválido → 400 com nome do campo', async () => {});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementar. **Step 4:** Run → PASS.
- [ ] **Step 5:** Verificação manual: com o Postgres da Task 1 rodando, `cp .env.example .env`, preencher token, `npm run dev`, `curl localhost:3000/saude` → `{"ok":true}`.
- [ ] **Step 6: Commit** `feat(nucleo): API HTTP da esteira`

---

### Task 8: CI e documentação de uso

**Files:**
- Create: `.github/workflows/nucleo.yml`, `nucleo/README.md`

- [ ] **Step 1:** Workflow: dispara em `push` e `pull_request` com `paths: ['nucleo/**']`; `runs-on: ubuntu-latest`; Node 22 com cache npm; `npm ci`, `npx tsc --noEmit`, `npm test` em `working-directory: nucleo`.
- [ ] **Step 2:** `README.md` (pt-BR): o que é o núcleo, como rodar local (Docker Postgres, `.env`, migrações, `npm run dev`), exemplo `curl` do fluxo completo (cliente → canal → evento → aprovação), como adicionar um serviço ao catálogo (novo YAML, sem código).
- [ ] **Step 3:** Verificar: `cd nucleo && npm ci && npx tsc --noEmit && npm test` → tudo verde localmente.
- [ ] **Step 4: Commit** `ci(nucleo): testes no GitHub Actions + README`

---

## Próximos planos (fora deste)

Plano 2 (canais + classificador Claude + fila Redis), Plano 3 (painel + Telegram), Plano 4 (agentes Escopo/QA/Publicador), Plano 5 (serviços do catálogo), Plano 6 (servidor próprio + migração da hospedagem atual e do app.grupofiore.com.br) — ver spec §14.1.
