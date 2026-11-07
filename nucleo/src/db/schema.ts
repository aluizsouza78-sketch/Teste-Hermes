import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const criadoEm = () => timestamp('criado_em', { withTimezone: true }).notNull().defaultNow();
const ts = (nome: string) => timestamp(nome, { withTimezone: true });

export const clientes = pgTable('clientes', {
  id: id(),
  criadoEm: criadoEm(),
  nome: text('nome').notNull(),
  contatos: jsonb('contatos').notNull().default(sql`'[]'::jsonb`),
  status: text('status').notNull().default('ativo'),
  cofreRef: text('cofre_ref'),
});

export const canaisCliente = pgTable(
  'canais_cliente',
  {
    id: id(),
    criadoEm: criadoEm(),
    clienteId: uuid('cliente_id').notNull().references(() => clientes.id),
    tipo: text('tipo').notNull(),
    identificador: text('identificador').notNull(),
  },
  (t) => [
    unique('canais_cliente_tipo_identificador_uq').on(t.tipo, t.identificador),
    check('canais_cliente_tipo_ck', sql`${t.tipo} in ('whatsapp_grupo','whatsapp_contato','email')`),
  ],
);

export const servicosContratados = pgTable(
  'servicos_contratados',
  {
    id: id(),
    criadoEm: criadoEm(),
    clienteId: uuid('cliente_id').notNull().references(() => clientes.id),
    servicoId: text('servico_id').notNull(),
    configuracao: jsonb('configuracao').notNull().default(sql`'{}'::jsonb`),
    nivelAutonomia: text('nivel_autonomia').notNull().default('N2'),
  },
  (t) => [
    unique('servicos_contratados_cliente_servico_uq').on(t.clienteId, t.servicoId),
    check('servicos_contratados_nivel_ck', sql`${t.nivelAutonomia} in ('N0','N1','N2','N3')`),
  ],
);

export const eventos = pgTable(
  'eventos',
  {
    id: id(),
    criadoEm: criadoEm(),
    canalTipo: text('canal_tipo').notNull(),
    canalIdentificador: text('canal_identificador').notNull(),
    idExterno: text('id_externo').notNull(),
    texto: text('texto').notNull(),
    recebidoEm: ts('recebido_em').notNull().defaultNow(),
    origemConfianca: text('origem_confianca').notNull().default('cliente'),
    clienteId: uuid('cliente_id').references(() => clientes.id),
    servicoId: text('servico_id'),
    confianca: real('confianca'),
    resumo: text('resumo'),
    status: text('status').notNull(),
  },
  (t) => [
    unique('eventos_canal_tipo_id_externo_uq').on(t.canalTipo, t.idExterno),
    check('eventos_origem_ck', sql`${t.origemConfianca} in ('operador','sistema','cliente','externo','gerado')`),
  ],
);

export const demandas = pgTable('demandas', {
  id: id(),
  criadoEm: criadoEm(),
  clienteId: uuid('cliente_id').notNull().references(() => clientes.id),
  servicoId: text('servico_id').notNull(),
  eventoId: uuid('evento_id').references(() => eventos.id),
  etapa: text('etapa').notNull(),
  tentativasQa: integer('tentativas_qa').notNull().default(0),
  titulo: text('titulo').notNull(),
  atualizadoEm: ts('atualizado_em').notNull().defaultNow(),
});

export const escopos = pgTable('escopos', {
  id: id(),
  criadoEm: criadoEm(),
  demandaId: uuid('demanda_id').notNull().references(() => demandas.id),
  versao: integer('versao').notNull(),
  conteudo: jsonb('conteudo').notNull(),
  status: text('status').notNull(),
});

export const entregas = pgTable(
  'entregas',
  {
    id: id(),
    criadoEm: criadoEm(),
    demandaId: uuid('demanda_id').notNull().references(() => demandas.id),
    repositorio: text('repositorio').notNull(),
    versao: text('versao').notNull(),
    ambiente: text('ambiente').notNull(),
    url: text('url'),
    status: text('status').notNull(),
  },
  (t) => [check('entregas_ambiente_ck', sql`${t.ambiente} in ('staging','producao')`)],
);

export const relatoriosQa = pgTable(
  'relatorios_qa',
  {
    id: id(),
    criadoEm: criadoEm(),
    demandaId: uuid('demanda_id').notNull().references(() => demandas.id),
    portao: integer('portao').notNull(),
    aprovado: boolean('aprovado').notNull(),
    evidencias: jsonb('evidencias').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [check('relatorios_qa_portao_ck', sql`${t.portao} in (1,2,3)`)],
);

export const validacoes = pgTable(
  'validacoes',
  {
    id: id(),
    criadoEm: criadoEm(),
    clienteId: uuid('cliente_id').notNull().references(() => clientes.id),
    eventoId: uuid('evento_id').references(() => eventos.id),
    campos: jsonb('campos').notNull().default(sql`'{}'::jsonb`),
    valorDeclarado: numeric('valor_declarado'),
    valorSistema: numeric('valor_sistema'),
    status: text('status').notNull(),
  },
  (t) => [
    check(
      'validacoes_status_ck',
      sql`${t.status} in ('confere','divergente','nao_encontrado','pendente_verificacao','revisao_humana')`,
    ),
  ],
);

export const aprovacoes = pgTable(
  'aprovacoes',
  {
    id: id(),
    criadoEm: criadoEm(),
    demandaId: uuid('demanda_id').notNull().references(() => demandas.id),
    tipo: text('tipo').notNull(),
    status: text('status').notNull().default('pendente'),
    detalhes: jsonb('detalhes').notNull().default(sql`'{}'::jsonb`),
    comentario: text('comentario'),
    decididoEm: ts('decidido_em'),
  },
  (t) => [
    check('aprovacoes_tipo_ck', sql`${t.tipo} in ('escopo','entrega','escalada','acao')`),
    check('aprovacoes_status_ck', sql`${t.status} in ('pendente','aprovada','recusada')`),
  ],
);

export const decisoesPolitica = pgTable(
  'decisoes_politica',
  {
    id: id(),
    criadoEm: criadoEm(),
    demandaId: uuid('demanda_id').notNull().references(() => demandas.id),
    clienteId: uuid('cliente_id').notNull().references(() => clientes.id),
    agente: text('agente').notNull(),
    ferramenta: text('ferramenta').notNull(),
    argumentos: jsonb('argumentos').notNull().default(sql`'{}'::jsonb`),
    nivelAutonomia: text('nivel_autonomia').notNull(),
    decisao: text('decisao').notNull(),
    motivo: text('motivo').notNull(),
  },
  (t) => [check('decisoes_politica_decisao_ck', sql`${t.decisao} in ('permitir','negar','exigir_aprovacao')`)],
);

export const pausas = pgTable(
  'pausas',
  {
    id: id(),
    criadoEm: criadoEm(),
    escopo: text('escopo').notNull(),
    alvo: text('alvo'),
    motivo: text('motivo').notNull(),
    encerradaEm: ts('encerrada_em'),
  },
  (t) => [check('pausas_escopo_ck', sql`${t.escopo} in ('global','cliente','agente')`)],
);

export const execucoesAgente = pgTable(
  'execucoes_agente',
  {
    id: id(),
    criadoEm: criadoEm(),
    demandaId: uuid('demanda_id').notNull().references(() => demandas.id),
    agente: text('agente').notNull(),
    modelo: text('modelo').notNull(),
    versaoPrompt: text('versao_prompt').notNull(),
    status: text('status').notNull().default('em_andamento'),
    turnos: integer('turnos').notNull().default(0),
    chamadasFerramenta: integer('chamadas_ferramenta').notNull().default(0),
    tokens: integer('tokens').notNull().default(0),
    custoCentavos: integer('custo_centavos').notNull().default(0),
    rastro: jsonb('rastro').notNull().default(sql`'[]'::jsonb`),
    finalizadoEm: ts('finalizado_em'),
  },
  (t) => [
    check(
      'execucoes_agente_status_ck',
      sql`${t.status} in ('em_andamento','concluida','interrompida_orcamento','interrompida_pausa','falhou')`,
    ),
  ],
);

export const orcamentos = pgTable(
  'orcamentos',
  {
    id: id(),
    criadoEm: criadoEm(),
    escopo: text('escopo').notNull(),
    clienteId: uuid('cliente_id').references(() => clientes.id),
    limiteDiarioCentavos: integer('limite_diario_centavos').notNull(),
  },
  (t) => [
    unique('orcamentos_escopo_cliente_uq').on(t.escopo, t.clienteId),
    check('orcamentos_escopo_ck', sql`${t.escopo} in ('global','cliente')`),
  ],
);

export const rotinas = pgTable('rotinas', {
  id: id(),
  criadoEm: criadoEm(),
  clienteId: uuid('cliente_id').notNull().references(() => clientes.id),
  entregaId: uuid('entrega_id').references(() => entregas.id),
  tipo: text('tipo').notNull(),
  cron: text('cron').notNull(),
  ultimaExecucao: ts('ultima_execucao'),
  ultimoResultado: text('ultimo_resultado'),
});

export const auditoria = pgTable('auditoria', {
  id: id(),
  criadoEm: criadoEm(),
  ator: text('ator').notNull(),
  acao: text('acao').notNull(),
  alvoTipo: text('alvo_tipo').notNull(),
  alvoId: uuid('alvo_id'),
  detalhes: jsonb('detalhes').notNull().default(sql`'{}'::jsonb`),
  credencialRef: text('credencial_ref'),
});
