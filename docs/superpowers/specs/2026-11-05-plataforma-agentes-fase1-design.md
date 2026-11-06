# Plataforma de Agentes — Fase 1 (Design)

- **Data:** 2026-11-05
- **Status:** rascunho para revisão
- **Escopo:** Fase 1 — infraestrutura base + esteira genérica de entrega + 3 serviços de catálogo + agente de QA

---

## 1. Contexto e objetivo

A empresa é uma prestadora de soluções de tecnologia (dashboards, automações, validações de dados, aplicativos internos, segurança/TI) para **vários clientes**. Cada cliente faz solicitações diferentes, por canais diferentes (WhatsApp, e-mail, conversa direta).

O objetivo é uma **plataforma própria, em servidor dedicado**, onde agentes de IA executam toda a esteira de uma demanda — da triagem à produção — com o operador (dono da empresa) como ponto de controle:

> **O operador define e aprova; os agentes executam; nada vai para produção sem passar pelo QA.**

### 1.1 Critérios de sucesso da Fase 1

1. Uma demanda de **qualquer cliente cadastrado**, vinda de WhatsApp ou e-mail, é detectada, associada ao cliente certo e classificada em um tipo de serviço — sem intervenção manual.
2. Para os serviços do catálogo, a esteira percorre **triagem → escopo → construção → QA → revisão → produção → operação** e o operador só atua nos pontos de aprovação.
3. O agente de QA bloqueia entregas com falha e devolve ao construtor com relatório; após 3 tentativas sem sucesso, escala ao operador.
4. Uma publicação em produção que falhe no teste pós-deploy é revertida automaticamente.
5. Adicionar um **novo cliente** exige apenas cadastro (sem código). Adicionar um **novo tipo de serviço** exige apenas um novo modelo de catálogo (sem alterar a esteira).
6. Clientes de teste: **Grupo Fiori** (validação de pagamentos WhatsApp × sistema) e **um cliente de dashboard** (ou planilha de exemplo).

### 1.2 Fora do escopo da Fase 1

- Portal para o cliente acessar a plataforma (clientes só recebem entregas).
- Faturamento/cobrança.
- Agente de Segurança/TI completo (fica como serviço "sob medida").
- Execução autônoma sem aprovação do operador (a estrutura de permissões permite liberar no futuro).
- Aplicativos móveis nativos.

---

## 2. Princípios

1. **Agnóstico de cliente:** nenhuma regra de negócio específica de cliente no código da esteira. Tudo que é específico vive no cadastro do cliente ou na configuração do serviço contratado.
2. **Separação de funções:** quem constrói não aprova. O QA é um agente separado, com instruções e permissões próprias.
3. **Humano no controle:** leitura é automática; qualquer ação que altere sistemas, publique ou fale com o cliente exige aprovação (configurável por tipo de ação no futuro).
4. **Na dúvida, não chuta:** baixa confiança da IA gera item de revisão humana, nunca uma decisão automática.
5. **Menor privilégio e isolamento:** cada cliente tem dados, credenciais, repositório e ambientes isolados; agentes recebem só as credenciais da tarefa em curso.
6. **Tudo auditável:** toda ação de agente ou operador é registrada.
7. **Portável:** roda em qualquer VPS/servidor dedicado com root (HostGator VPS, Hetzner, AWS etc.).

---

## 3. Topologia

```
                  ┌──────────────── SERVIDOR DEDICADO (Docker Compose) ───────────────┐
                  │                                                                    │
 WhatsApp ───────▶│ [Gateway WhatsApp]  Evolution API (número dedicado)                │
 E-mail ─────────▶│ [Conectores]        n8n: IMAP/Gmail/Outlook, webhooks, agendas     │
 Operador ───────▶│ [Canal do operador] Telegram/WhatsApp privado + Painel web         │
                  │            │                                                       │
                  │            ▼                                                       │
                  │ [Fila de eventos — Redis]                                          │
                  │            │                                                       │
                  │            ▼                                                       │
                  │ [ORQUESTRADOR / Gestor]  ── consulta ──▶ [Catálogo de serviços]    │
                  │   identifica cliente, classifica, cria demanda, move etapas        │
                  │            │                                                       │
                  │   ┌────────┼──────────────┬───────────────┬──────────────┐         │
                  │   ▼        ▼              ▼               ▼              ▼         │
                  │ [Escopo] [Construtores]  [QA]          [Publicador]  [Operação]    │
                  │          Dados/BI, Dev,   portões 1-3   deploy +      rotinas,     │
                  │          Validação                      rollback      monitoração  │
                  │                                                                    │
                  │ [Postgres] dados   [Infisical] segredos   [Runner GitHub Actions]  │
                  │ [Traefik] proxy/TLS das entregas   [Ambientes staging/prod por     │
                  │                                     cliente — containers isolados] │
                  └───────────────┬────────────────────────────────────────────────────┘
                                  │  Acesso admin somente via Tailscale (VPN)
                                  ▼
                   Sistemas dos clientes (APIs, bancos, apps) · GitHub (repos por cliente)
```

---

## 4. A esteira única

Toda demanda, de qualquer cliente, percorre as mesmas etapas. O tipo de serviço só muda **qual agente constrói** e **quais testes extras o QA aplica**.

| # | Etapa | Responsável | Saída | Gate humano |
|---|-------|-------------|-------|-------------|
| 1 | Triagem | Gestor | Demanda vinculada a cliente + tipo de serviço (ou "ignorar"/"sob medida") | Só se confiança baixa |
| 2 | Escopo | Agente de Escopo | Mini-proposta: o que será entregue, dados necessários, prazo estimado, critérios de aceite | **Sim — aprova escopo** |
| 3 | Construção | Agente construtor do tipo | Código no repo do cliente + testes + descrição | — |
| 4 | QA portões 1 e 2 | Agente de QA | Relatório de QA + link de prévia (staging) | — |
| 5 | Revisão | Operador | Aprovação ou pedido de ajuste | **Sim — aprova entrega** |
| 6 | Produção (QA portão 3) | Publicador + QA | Versão em produção validada, ou rollback | — |
| 7 | Operação | Agente de Operação + QA | Rotinas agendadas e smoke tests periódicos | Só em alerta |

**Retornos:**
- Pedido de ajuste na etapa 2 ou 5 → volta à etapa anterior com o comentário do operador.
- Falha no QA → volta à construção com relatório; **máximo 3 tentativas**, depois vai para a caixa de aprovações do operador com o histórico.

---

## 5. Agentes

Todos são implementados com o **Claude Agent SDK**, cada um com prompt de sistema, ferramentas e permissões próprios. Nenhum agente tem acesso direto a credenciais: pede ao serviço de segredos, que entrega apenas o escopo do cliente/tarefa corrente.

| Agente | Função | Ferramentas principais | Não pode |
|--------|--------|------------------------|----------|
| **Gestor (orquestrador)** | Identifica cliente, classifica, cria/move demandas, chama agentes | Banco (leitura/escrita de demandas), catálogo, notificações | Construir, publicar |
| **Escopo** | Transforma pedido em proposta com critérios de aceite | Banco, leitura de anexos (Excel, PDF), histórico do cliente | Publicar, falar com o cliente |
| **Dados/BI** | Constrói dashboards a partir de planilhas/bases | Repo do cliente, sandbox de execução, modelo de dashboard | Publicar em produção |
| **Validação** | Configura e mantém regras de validação/conciliação | Repo do cliente, conectores do sistema do cliente (leitura) | Alterar dados no sistema do cliente |
| **Dev** | Demandas "sob medida" e apps internos | Repo do cliente, sandbox, modelos de app | Publicar em produção |
| **QA** | Portões 1, 2 e 3; smoke tests periódicos | Testes, scanners de segurança, Playwright, staging, comparação de dados | Alterar código de produção (só reporta) |
| **Publicador** | Deploy em staging/produção e rollback | Docker/Traefik, runner, repo (tags) | Publicar sem QA aprovado + aprovação do operador |
| **Operação** | Executa rotinas agendadas (atualização de dados, validações recorrentes) | Agendador, conectores, notificações | Mudar código |

---

## 6. Agente de QA — portões

**Portão 1 — Código** (após construção)
- Executa a suíte de testes do repositório; cria testes faltantes para os critérios de aceite do escopo.
- Varredura de segurança: segredos no código (gitleaks), dependências vulneráveis (npm audit / pip-audit / Trivy), análise estática (Semgrep).
- Revisão contra o escopo aprovado: cada critério de aceite tem evidência.

**Portão 2 — Homologação (staging)**
- Publica no ambiente de staging isolado do cliente.
- Testes ponta a ponta no navegador (Playwright) com capturas de tela, desktop e celular.
- Testes específicos do tipo de serviço (definidos no catálogo — ver seção 7).
- Gera **Relatório de QA**: o que foi testado, resultados, capturas, riscos.

**Portão 3 — Produção** (após aprovação do operador)
- Publicação em produção pelo Publicador.
- Smoke test pós-deploy: disponibilidade, autenticação, carga de dados.
- Falha → **rollback automático** para a versão anterior + alerta ao operador + nova demanda de investigação.

**Contínuo:** smoke test periódico (padrão: a cada hora) de toda entrega em produção.

---

## 7. Catálogo de serviços

Um **modelo de serviço** é um arquivo de configuração versionado (YAML) + um repositório-modelo de código. A esteira lê o modelo; não há `if cliente == ...` no código.

Campos de um modelo:

```yaml
id: planilha-dashboard
nome: Planilha → Dashboard
entradas_escopo:        # o que o agente de Escopo precisa coletar
  - planilha (xlsx/csv)
  - indicadores desejados
  - quem terá acesso
construtor: agente-dados-bi
repo_modelo: modelos/dashboard
testes_qa_extras:       # além dos portões padrão
  - conferencia_totais_com_origem
  - filtros_retornam_subconjunto_correto
  - acesso_somente_autenticado
publicacao: container-web
rotinas_operacao:
  - atualizar_dados (frequência definida no escopo)
```

### 7.1 Serviços da Fase 1

**A. Planilha → Dashboard**
- Entrada: planilha Excel/CSV (ou fonte de dados) + indicadores desejados.
- Entrega: dashboard web responsivo com login, publicado em subdomínio do cliente.
- QA extra: totais e agregações do dashboard batem com a planilha de origem; filtros consistentes; acesso só autenticado.

**B. Validação/Conciliação**
- Genérico: confere uma informação **declarada em um canal** (mensagem de WhatsApp, e-mail) contra o **registro no sistema do cliente**.
- Configuração por cliente (no escopo): quais canais/grupos monitorar, o que extrair (ex.: valor, identificador, data), como consultar o sistema (API/banco, somente leitura), tolerâncias, para quem alertar.
- Resultado por item: `confere`, `divergente`, `nao_encontrado`, `pendente_verificacao` (sistema indisponível), `revisao_humana` (baixa confiança na extração).
- QA extra: **conjunto de mensagens rotuladas** por cliente; o extrator precisa manter **≥ 98% de acerto** para ser publicado ou alterado.
- Cliente de teste: Grupo Fiori (confirmações de pagamento no grupo × valores no app).

**C. Sob medida**
- Qualquer pedido fora do catálogo. Escopo montado do zero; construtor = agente Dev; QA aplica portões padrão + critérios de aceite do escopo.
- Pedidos sob medida recorrentes viram candidatos a novo modelo de catálogo.

---

## 8. Dados (Postgres)

| Tabela | Conteúdo principal |
|--------|--------------------|
| `clientes` | nome, contatos, status, referência ao espaço no cofre de segredos |
| `canais_cliente` | tipo (whatsapp_grupo, whatsapp_contato, email), identificador, cliente |
| `servicos_catalogo` | id do modelo, versão, configuração |
| `servicos_contratados` | cliente × serviço + configuração específica do cliente |
| `eventos` | mensagem/e-mail bruto recebido, canal, cliente identificado, classificação, confiança |
| `demandas` | cliente, tipo de serviço, origem (evento), etapa atual, tentativas |
| `escopos` | proposta, critérios de aceite, versão, status de aprovação |
| `entregas` | repositório, versão/tag, ambiente (staging/prod), URL, status |
| `relatorios_qa` | demanda, portão, resultado, evidências |
| `validacoes` | cliente, origem, campos extraídos, valor declarado, valor no sistema, status |
| `aprovacoes` | item, tipo, decisão, comentário, quem, quando |
| `rotinas` | cliente/entrega, tipo, agenda (cron), última execução, resultado |
| `auditoria` | ator (agente/operador), ação, alvo, credencial usada, timestamp |

**Regra:** credenciais nunca são gravadas no Postgres — somente referências ao cofre (Infisical).

---

## 9. Painel do operador

Acessível **somente via Tailscale**. Telas:

1. **Caixa de entrada** — eventos recebidos e classificados; permite reclassificar ou vincular a outro cliente.
2. **Aprovações pendentes** — escopos, entregas (relatório de QA + link de prévia), validações em `revisao_humana`/`divergente`, tarefas escaladas após 3 tentativas.
3. **Clientes** — cadastro, canais, serviços contratados.
4. **Demandas/projetos** — por cliente, com etapa atual e histórico.
5. **Auditoria** — busca por cliente, agente, ação, período.

**Notificações:** mensagem no canal privado do operador (Telegram ou WhatsApp) com link direto ao item.

---

## 10. Tratamento de erros

| Situação | Comportamento |
|----------|---------------|
| Agente falha ou expira | Demanda volta à fila; após 3 tentativas → aprovações do operador com erro explicado |
| WhatsApp desconecta | Alerta imediato (Telegram/e-mail); QR code de reconexão no painel; mensagens do período recuperadas na reconexão |
| Sistema do cliente indisponível | Validação fica `pendente_verificacao`; nova tentativa com backoff; nunca marca `confere` sem consulta |
| Baixa confiança da IA (classificação ou extração) | Item vai para `revisao_humana`; nenhuma ação automática |
| Mensagem de cliente não identificado | Fica na caixa de entrada como "cliente desconhecido" |
| Falha no smoke test de produção | Rollback automático + alerta + demanda de investigação |
| Perda do servidor | Backup diário do Postgres e dos volumes para armazenamento externo, retenção de 30 dias; infraestrutura recriável via Docker Compose + repositório |

---

## 11. Segurança

- Acesso administrativo (painel, SSH, n8n, Evolution API) somente via **Tailscale**; nenhuma porta administrativa exposta.
- Apenas Traefik (80/443) exposto, servindo as entregas publicadas, com TLS automático.
- Segredos no **Infisical**, separados por cliente; agentes obtêm credenciais com escopo e duração limitados.
- Conectores aos sistemas dos clientes em **modo somente leitura** sempre que possível.
- Ambientes de staging e produção de cada cliente em containers e redes Docker separados.
- Código dos agentes executado em sandbox (container descartável) sem acesso à rede de outros clientes.
- Auditoria imutável (somente inserção).
- **Risco WhatsApp:** a leitura de grupos usa API não oficial (Evolution API), contra os termos do WhatsApp; risco de banimento do número. Mitigação: número dedicado da empresa, nunca o pessoal; plano de reconexão; avaliar API oficial para canais 1:1 no futuro.

---

## 12. Tecnologia

| Camada | Escolha |
|--------|---------|
| Servidor | VPS/dedicado Ubuntu LTS, mínimo 4 vCPU / 8 GB RAM / 80 GB SSD |
| Orquestração de containers | Docker Compose |
| Linguagem do núcleo | TypeScript (Node.js) |
| Agentes | Claude Agent SDK + API do Claude |
| Integrações/gatilhos | n8n (self-hosted) |
| WhatsApp | Evolution API |
| Banco / fila | Postgres / Redis |
| Segredos | Infisical (self-hosted) |
| Proxy/TLS | Traefik |
| VPN admin | Tailscale |
| Painel | Next.js |
| Modelo de dashboard | Next.js + biblioteca de gráficos (a definir no plano) |
| Testes E2E | Playwright |
| Segurança no QA | gitleaks, Semgrep, Trivy / npm audit |
| Código das entregas | GitHub — Organização gratuita da empresa, um repositório privado por cliente |
| CI | GitHub Actions com **runner self-hosted** no servidor |

### 12.1 GitHub Free

A Fase 1 é **compatível com GitHub Free** (Organização gratuita):
- Repositórios privados e colaboradores ilimitados.
- Minutos de Actions não são consumidos, pois o CI roda no runner self-hosted.
- O controle de publicação é feito pela plataforma (portões de QA + aprovação), não por proteção de branch do GitHub.
- Migrar para GitHub Team quando houver equipe de desenvolvedores ou exigência de cliente por proteção de branch/revisões obrigatórias.

---

## 13. Testes da própria plataforma

- **Unitários:** classificação, roteamento de etapas, regras de tentativas/escalonamento, comparação de validações.
- **Integração:** fluxo completo de uma demanda simulada por tipo de serviço (A, B, C) com sistemas de cliente simulados.
- **Conjunto rotulado de classificação:** mensagens de exemplo com cliente e tipo esperados, para medir a triagem.
- **Teste de rollback:** publicação deliberadamente quebrada deve ser revertida.
- **Teste de isolamento:** agente na tarefa do cliente X não consegue ler credenciais ou dados do cliente Y.

---

## 14. Ordem de implementação sugerida (detalhada no plano)

1. Infra base: servidor, Docker Compose, Tailscale, Traefik, Postgres, Redis, Infisical, runner.
2. Núcleo: modelo de dados, cadastro de clientes/canais, fila, orquestrador e esteira (etapas e gates).
3. Painel mínimo: caixa de entrada, aprovações, clientes, demandas.
4. Canais: e-mail (n8n) e WhatsApp (Evolution API) → eventos.
5. Agentes de Escopo, QA e Publicador (comuns a todos os serviços).
6. Serviço B — Validação/Conciliação, com a Fiori como cliente de teste.
7. Serviço A — Planilha → Dashboard.
8. Serviço C — Sob medida (agente Dev).
9. Operação: rotinas agendadas e smoke tests periódicos.

---

### 14.1 Divisão em planos de implementação

Cada plano entrega software funcional e testável por si só:

| Plano | Conteúdo | Depende de hospedagem? |
|-------|----------|------------------------|
| 1 | **Núcleo da esteira:** dados, clientes/canais, catálogo, máquina de etapas, aprovações, auditoria, ingestão de eventos, API | Não (roda local via Docker) |
| 2 | Canais + triagem com IA: e-mail (n8n), WhatsApp (Evolution API), fila Redis, classificador Claude | Não |
| 3 | Painel do operador (Next.js) + notificações Telegram | Não |
| 4 | Agentes comuns: Escopo, QA (portões 1–3), Publicador (deploy/rollback) | Parcial (staging local) |
| 5 | Serviços do catálogo: Validação/Conciliação (Fiori), Planilha → Dashboard, Sob medida | Não |
| 6 | **Servidor próprio e migração:** provisionamento, Tailscale, Traefik, backups, runner; migração dos sites da hospedagem compartilhada atual e do app **app.grupofiori.com.br** para o servidor | **Sim** |

## 15. Decisões em aberto

- **Provedor do servidor** (HostGator VPS/dedicado ou outro) — não bloqueia os planos 1–5; necessário antes do plano 6. Intenção: sair da hospedagem compartilhada e concentrar todos os serviços (incluindo o app da Fiori) no servidor próprio.
- **App app.grupofiori.com.br:** levantar stack, banco de dados, domínio/DNS e variáveis de ambiente antes do plano 6.
- **Canal privado do operador:** Telegram (mais simples e oficial) ou WhatsApp — padrão sugerido: Telegram.
- **Acesso ao sistema da Fiori:** confirmar se há API ou acesso de leitura ao banco.
- **Cliente de teste para dashboard:** cliente real ou planilha de exemplo.
