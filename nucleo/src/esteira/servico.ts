import { and, desc, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/cliente.js';
import { aprovacoes, clientes, demandas } from '../db/schema.js';
import { registrarAuditoria } from '../auditoria/registrar.js';
import { SERVICO_SOB_MEDIDA } from '../catalogo/carregar.js';
import { Pausado, estaPausado } from '../seguranca/pausas.js';
import { transicionar, type Acao, type Ator, type Etapa, type EstadoDemanda } from './maquina.js';

export class DemandaNaoEncontrada extends Error {
  constructor(readonly demandaId: string) {
    super(`Demanda não encontrada: ${demandaId}`);
    this.name = 'DemandaNaoEncontrada';
  }
}

export class AprovacaoNaoEncontrada extends Error {
  constructor(readonly aprovacaoId: string) {
    super(`Aprovação não encontrada: ${aprovacaoId}`);
    this.name = 'AprovacaoNaoEncontrada';
  }
}

export class AprovacaoJaDecidida extends Error {
  constructor(readonly aprovacaoId: string, readonly status: string) {
    super(`Aprovação ${aprovacaoId} já decidida (${status})`);
    this.name = 'AprovacaoJaDecidida';
  }
}

export interface DemandaResumo {
  id: string;
  clienteId: string;
  servicoId: string;
  titulo: string;
  etapa: Etapa;
  tentativasQa: number;
}

const colunasResumo = {
  id: demandas.id,
  clienteId: demandas.clienteId,
  servicoId: demandas.servicoId,
  titulo: demandas.titulo,
  etapa: demandas.etapa,
  tentativasQa: demandas.tentativasQa,
};

const nomeAtor = (a: Ator): string => (a.tipo === 'operador' ? 'operador' : `agente:${a.nome}`);

async function criarDemandaTx(
  tx: Tx,
  d: { clienteId: string; servicoId: string; titulo: string; eventoId?: string },
  ator: string,
): Promise<{ id: string }> {
  const [r] = await tx
    .insert(demandas)
    .values({
      clienteId: d.clienteId,
      servicoId: d.servicoId,
      titulo: d.titulo,
      eventoId: d.eventoId ?? null,
      etapa: 'escopo',
    })
    .returning({ id: demandas.id });
  await registrarAuditoria(tx, {
    ator,
    acao: 'demanda.criada',
    alvoTipo: 'demanda',
    alvoId: r.id,
    detalhes: { clienteId: d.clienteId, servicoId: d.servicoId, titulo: d.titulo },
  });
  return { id: r.id };
}

export function criarDemanda(
  db: Db,
  d: { clienteId: string; servicoId: string; titulo: string; eventoId?: string },
  ator: Ator,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    // Pausa de emergência também impede agentes de abrir demandas.
    if (ator.tipo === 'agente' && (await estaPausado(tx, { clienteId: d.clienteId, agente: ator.nome }))) {
      throw new Pausado(d.clienteId, ator.nome);
    }
    return criarDemandaTx(tx, d, nomeAtor(ator));
  });
}

export async function obterDemanda(db: Db | Tx, id: string): Promise<DemandaResumo> {
  const [d] = await db.select(colunasResumo).from(demandas).where(eq(demandas.id, id));
  if (!d) throw new DemandaNaoEncontrada(id);
  return d as DemandaResumo;
}

/** Lê a demanda com SELECT … FOR UPDATE (serializa transições concorrentes). */
async function travarDemanda(tx: Tx, id: string): Promise<DemandaResumo> {
  const [d] = await tx.select(colunasResumo).from(demandas).where(eq(demandas.id, id)).for('update');
  if (!d) throw new DemandaNaoEncontrada(id);
  return d as DemandaResumo;
}

/** Aplica a transição dentro da transação: estado, aprovação aberta, falha em produção e auditoria. */
async function aplicar(
  tx: Tx,
  demanda: DemandaResumo,
  acao: Acao,
  ator: Ator,
  motivo?: string,
  extraAuditoria: Record<string, unknown> = {},
): Promise<EstadoDemanda> {
  const r = transicionar({ etapa: demanda.etapa, tentativasQa: demanda.tentativasQa }, acao, ator, motivo);
  await tx
    .update(demandas)
    .set({ etapa: r.etapa, tentativasQa: r.tentativasQa, atualizadoEm: new Date() })
    .where(eq(demandas.id, demanda.id));
  const motivoFinal = motivo ?? r.motivo;
  await registrarAuditoria(tx, {
    ator: nomeAtor(ator),
    acao: 'demanda.transicao',
    alvoTipo: 'demanda',
    alvoId: demanda.id,
    detalhes: {
      de: demanda.etapa,
      para: r.etapa,
      acao,
      ...(motivoFinal !== undefined ? { motivo: motivoFinal } : {}),
      ...extraAuditoria,
    },
  });
  if (r.etapa === 'cancelada') {
    const fechadas = await tx
      .update(aprovacoes)
      .set({ status: 'recusada', comentario: 'demanda cancelada', decididoEm: new Date() })
      .where(and(eq(aprovacoes.demandaId, demanda.id), eq(aprovacoes.status, 'pendente')))
      .returning({ id: aprovacoes.id, tipo: aprovacoes.tipo });
    for (const f of fechadas) {
      await registrarAuditoria(tx, {
        ator: nomeAtor(ator),
        acao: 'aprovacao.decidida',
        alvoTipo: 'aprovacao',
        alvoId: f.id,
        detalhes: { demandaId: demanda.id, tipo: f.tipo, decisao: 'recusar', automatico: true, motivo: 'demanda_cancelada' },
      });
    }
  }
  if (r.abrirAprovacao) {
    const [ap] = await tx
      .insert(aprovacoes)
      .values({
        demandaId: demanda.id,
        tipo: r.abrirAprovacao,
        detalhes: motivoFinal !== undefined ? { motivo: motivoFinal } : {},
      })
      .returning({ id: aprovacoes.id });
    await registrarAuditoria(tx, {
      ator: nomeAtor(ator),
      acao: 'aprovacao.aberta',
      alvoTipo: 'aprovacao',
      alvoId: ap.id,
      detalhes: { demandaId: demanda.id, tipo: r.abrirAprovacao },
    });
  }
  if (acao === 'producao_falhou') {
    const inv = await criarDemandaTx(
      tx,
      {
        clienteId: demanda.clienteId,
        servicoId: SERVICO_SOB_MEDIDA,
        titulo: `Investigar falha em produção: ${demanda.titulo}`,
      },
      nomeAtor(ator),
    );
    await registrarAuditoria(tx, {
      ator: nomeAtor(ator),
      acao: 'demanda.investigacao_criada',
      alvoTipo: 'demanda',
      alvoId: demanda.id,
      detalhes: { demandaInvestigacaoId: inv.id },
    });
  }
  return { etapa: r.etapa, tentativasQa: r.tentativasQa };
}

export function executarAcao(
  db: Db,
  demandaId: string,
  acao: Exclude<Acao, 'aprovar' | 'recusar' | 'retomar'>,
  ator: Ator,
  motivo?: string,
): Promise<EstadoDemanda> {
  return db.transaction(async (tx) => {
    const demanda = await travarDemanda(tx, demandaId);
    // Pausa de emergência bloqueia agentes; ações do operador seguem permitidas.
    if (ator.tipo === 'agente' && (await estaPausado(tx, { clienteId: demanda.clienteId, agente: ator.nome }))) {
      throw new Pausado(demanda.clienteId, ator.nome);
    }
    return aplicar(tx, demanda, acao, ator, motivo);
  });
}

const OPERADOR: Ator = { tipo: 'operador' };

export function decidirAprovacao(
  db: Db,
  aprovacaoId: string,
  decisao: 'aprovar' | 'recusar',
  comentario: string | null,
): Promise<EstadoDemanda> {
  return db.transaction(async (tx) => {
    // Mesma ordem de travas de aplicar() (demanda → aprovação), evitando deadlock
    // com um cancelamento concorrente: lê a aprovação sem trava só para achar a demanda.
    const [ref] = await tx
      .select({ demandaId: aprovacoes.demandaId })
      .from(aprovacoes)
      .where(eq(aprovacoes.id, aprovacaoId));
    if (!ref) throw new AprovacaoNaoEncontrada(aprovacaoId);
    const demanda = await travarDemanda(tx, ref.demandaId);

    const [ap] = await tx.select().from(aprovacoes).where(eq(aprovacoes.id, aprovacaoId)).for('update');
    if (!ap) throw new AprovacaoNaoEncontrada(aprovacaoId);
    if (ap.status !== 'pendente') throw new AprovacaoJaDecidida(aprovacaoId, ap.status);

    const aprovar = decisao === 'aprovar';
    await tx
      .update(aprovacoes)
      .set({ status: aprovar ? 'aprovada' : 'recusada', comentario, decididoEm: new Date() })
      .where(eq(aprovacoes.id, aprovacaoId));
    await registrarAuditoria(tx, {
      ator: 'operador',
      acao: 'aprovacao.decidida',
      alvoTipo: 'aprovacao',
      alvoId: aprovacaoId,
      detalhes: {
        demandaId: ap.demandaId,
        tipo: ap.tipo,
        decisao,
        ...(comentario !== null ? { comentario } : {}),
      },
    });

    if (ap.tipo === 'acao') return { etapa: demanda.etapa, tentativasQa: demanda.tentativasQa };

    const acao: Acao =
      ap.tipo === 'escalada' ? (aprovar ? 'retomar' : 'cancelar') : aprovar ? 'aprovar' : 'recusar';
    return aplicar(tx, demanda, acao, OPERADOR, undefined, comentario !== null ? { comentario } : {});
  });
}

export interface AprovacaoPendente {
  id: string;
  tipo: string;
  demandaId: string;
  clienteNome: string;
  tituloDemanda: string;
  /** Etapa atual da demanda. */
  etapa: Etapa;
  /** Fato exato sob aprovação, como gravado: {ferramenta, argumentos} em 'acao', {motivo} em escalada. */
  detalhes: unknown;
  criadoEm: Date;
}

export async function listarAprovacoesPendentes(db: Db): Promise<AprovacaoPendente[]> {
  const rows = await db
    .select({
      id: aprovacoes.id,
      tipo: aprovacoes.tipo,
      demandaId: aprovacoes.demandaId,
      clienteNome: clientes.nome,
      tituloDemanda: demandas.titulo,
      etapa: demandas.etapa,
      detalhes: aprovacoes.detalhes,
      criadoEm: aprovacoes.criadoEm,
    })
    .from(aprovacoes)
    .innerJoin(demandas, eq(aprovacoes.demandaId, demandas.id))
    .innerJoin(clientes, eq(demandas.clienteId, clientes.id))
    .where(eq(aprovacoes.status, 'pendente'))
    .orderBy(aprovacoes.criadoEm);
  return rows as AprovacaoPendente[];
}

export async function listarDemandas(db: Db, filtro: { clienteId?: string }): Promise<DemandaResumo[]> {
  const q = db.select(colunasResumo).from(demandas);
  const rows = await (filtro.clienteId ? q.where(eq(demandas.clienteId, filtro.clienteId)) : q).orderBy(
    desc(demandas.criadoEm),
  );
  return rows as DemandaResumo[];
}
