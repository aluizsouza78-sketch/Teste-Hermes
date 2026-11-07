import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/cliente.js';
import { demandas, execucoesAgente, orcamentos } from '../db/schema.js';
import { registrarAuditoria } from '../auditoria/registrar.js';
import { executarAcao } from '../esteira/servico.js';
import { TransicaoInvalida } from '../esteira/maquina.js';
import { Pausado, estaPausado } from './pausas.js';

export const LIMITES_EXECUCAO = { turnos: 50, chamadasFerramenta: 100, tokens: 500_000, minutos: 30 };

export type Alerta = 'orcamento_cliente_80' | 'orcamento_global_80';

export interface Uso {
  turnos: number;
  chamadasFerramenta: number;
  tokens: number;
  minutos: number;
  gastoDiaClienteCentavos: number;
  gastoDiaGlobalCentavos: number;
}

export interface Limites {
  porExecucao: typeof LIMITES_EXECUCAO;
  diarioClienteCentavos: number | null;
  diarioGlobalCentavos: number | null;
}

export interface Avaliacao {
  continuar: boolean;
  motivo?: string;
  alertas: Alerta[];
}

export class OrcamentoEsgotado extends Error {
  constructor(readonly escopo: 'cliente' | 'global') {
    super(`Orçamento diário ${escopo} esgotado`);
    this.name = 'OrcamentoEsgotado';
  }
}

export class ExecucaoNaoEncontrada extends Error {
  constructor(readonly execucaoId: string) {
    super(`Execução não encontrada: ${execucaoId}`);
    this.name = 'ExecucaoNaoEncontrada';
  }
}

export class ExecucaoEncerrada extends Error {
  constructor(readonly execucaoId: string, readonly status: string) {
    super(`Execução ${execucaoId} já encerrada (${status})`);
    this.name = 'ExecucaoEncerrada';
  }
}

const FUSO = 'America/Sao_Paulo';
const SISTEMA = { tipo: 'agente', nome: 'sistema' } as const;
const relogioPadrao = () => new Date();

/** Pura: limite excedido quando valor > limite; diário alerta em >= 80% e corta em >= 100%. */
export function avaliarLimites(uso: Uso, limites: Limites): Avaliacao {
  const l = limites.porExecucao;
  const diario = (gasto: number, limite: number | null) =>
    limite === null ? ('ok' as const) : gasto >= limite ? ('corte' as const) : gasto * 10 >= limite * 8 ? ('alerta' as const) : ('ok' as const);
  const cliente = diario(uso.gastoDiaClienteCentavos, limites.diarioClienteCentavos);
  const global = diario(uso.gastoDiaGlobalCentavos, limites.diarioGlobalCentavos);

  const alertas: Alerta[] = [];
  if (cliente === 'alerta') alertas.push('orcamento_cliente_80');
  if (global === 'alerta') alertas.push('orcamento_global_80');

  const motivo =
    uso.turnos > l.turnos ? 'turnos'
    : uso.chamadasFerramenta > l.chamadasFerramenta ? 'chamadas_ferramenta'
    : uso.tokens > l.tokens ? 'tokens'
    : uso.minutos > l.minutos ? 'tempo'
    : cliente === 'corte' ? 'orcamento_cliente'
    : global === 'corte' ? 'orcamento_global'
    : undefined;
  return motivo === undefined ? { continuar: true, alertas } : { continuar: false, motivo, alertas };
}

/** Gasto (centavos) das execuções do dia corrente em São Paulo; opcionalmente só de um cliente. */
async function gastoDoDia(db: Db | Tx, agora: Date, clienteId?: string): Promise<number> {
  const ref = agora.toISOString();
  const inicio = sql`(date_trunc('day', ${ref}::timestamptz AT TIME ZONE ${FUSO}) AT TIME ZONE ${FUSO})`;
  const fim = sql`((date_trunc('day', ${ref}::timestamptz AT TIME ZONE ${FUSO}) + interval '1 day') AT TIME ZONE ${FUSO})`;
  const base = db
    .select({ total: sql<string>`coalesce(sum(${execucoesAgente.custoCentavos}), 0)` })
    .from(execucoesAgente);
  const periodo = and(gte(execucoesAgente.criadoEm, inicio), lt(execucoesAgente.criadoEm, fim));
  const [r] =
    clienteId === undefined
      ? await base.where(periodo)
      : await base.innerJoin(demandas, eq(execucoesAgente.demandaId, demandas.id)).where(and(periodo, eq(demandas.clienteId, clienteId)));
  return Number(r.total);
}

async function limitesDiarios(
  db: Db | Tx,
  clienteId: string,
): Promise<{ cliente: number | null; global: number | null }> {
  const rows = await db.select().from(orcamentos);
  return {
    cliente: rows.find((o) => o.escopo === 'cliente' && o.clienteId === clienteId)?.limiteDiarioCentavos ?? null,
    global: rows.find((o) => o.escopo === 'global')?.limiteDiarioCentavos ?? null,
  };
}

export async function iniciarExecucao(
  db: Db,
  p: { demandaId: string; agente: string; modelo: string; versaoPrompt: string },
  agora: () => Date = relogioPadrao,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [d] = await tx.select({ clienteId: demandas.clienteId }).from(demandas).where(eq(demandas.id, p.demandaId));
    if (!d) throw new Error(`Demanda não encontrada: ${p.demandaId}`);
    if (await estaPausado(tx, { clienteId: d.clienteId, agente: p.agente })) throw new Pausado(d.clienteId, p.agente);

    const lim = await limitesDiarios(tx, d.clienteId);
    const t = agora();
    if (lim.cliente !== null && (await gastoDoDia(tx, t, d.clienteId)) >= lim.cliente) throw new OrcamentoEsgotado('cliente');
    if (lim.global !== null && (await gastoDoDia(tx, t)) >= lim.global) throw new OrcamentoEsgotado('global');

    const [r] = await tx
      .insert(execucoesAgente)
      .values({ demandaId: p.demandaId, agente: p.agente, modelo: p.modelo, versaoPrompt: p.versaoPrompt })
      .returning({ id: execucoesAgente.id });
    await registrarAuditoria(tx, {
      ator: `agente:${p.agente}`,
      acao: 'execucao.iniciada',
      alvoTipo: 'execucao_agente',
      alvoId: r.id,
      detalhes: { demandaId: p.demandaId, modelo: p.modelo, versaoPrompt: p.versaoPrompt },
    });
    return { id: r.id };
  });
}

export async function registrarConsumo(
  db: Db,
  execucaoId: string,
  delta: { turnos?: number; chamadasFerramenta?: number; tokens?: number; custoCentavos?: number; passo?: Record<string, unknown> },
  agora: () => Date = relogioPadrao,
): Promise<Avaliacao> {
  const { avaliacao, demandaId } = await db.transaction(async (tx) => {
    const [e] = await tx.select().from(execucoesAgente).where(eq(execucoesAgente.id, execucaoId)).for('update');
    if (!e) throw new ExecucaoNaoEncontrada(execucaoId);
    if (e.status !== 'em_andamento') throw new ExecucaoEncerrada(execucaoId, e.status);

    const t = agora();
    const novo = {
      turnos: e.turnos + (delta.turnos ?? 0),
      chamadasFerramenta: e.chamadasFerramenta + (delta.chamadasFerramenta ?? 0),
      tokens: e.tokens + (delta.tokens ?? 0),
      custoCentavos: e.custoCentavos + (delta.custoCentavos ?? 0),
    };
    const rastro = delta.passo ? [...(e.rastro as unknown[]), delta.passo] : e.rastro;
    await tx.update(execucoesAgente).set({ ...novo, rastro }).where(eq(execucoesAgente.id, execucaoId));

    const [d] = await tx.select({ clienteId: demandas.clienteId }).from(demandas).where(eq(demandas.id, e.demandaId));
    const lim = await limitesDiarios(tx, d.clienteId);
    // O delta já foi gravado acima, então o gasto do dia inclui a execução corrente.
    const uso: Uso = {
      ...novo,
      minutos: (t.getTime() - e.criadoEm.getTime()) / 60_000,
      gastoDiaClienteCentavos: await gastoDoDia(tx, t, d.clienteId),
      gastoDiaGlobalCentavos: await gastoDoDia(tx, t),
    };
    const avaliacao = avaliarLimites(uso, {
      porExecucao: LIMITES_EXECUCAO,
      diarioClienteCentavos: lim.cliente,
      diarioGlobalCentavos: lim.global,
    });
    const ator = `agente:${e.agente}`;
    if (avaliacao.alertas.length > 0) {
      await registrarAuditoria(tx, {
        ator, acao: 'execucao.alerta_orcamento', alvoTipo: 'execucao_agente', alvoId: execucaoId,
        detalhes: { alertas: avaliacao.alertas },
      });
    }
    // Pausa tem precedência: interrompe sem escalar (a pausa já é ação do operador).
    if (await estaPausado(tx, { clienteId: d.clienteId, agente: e.agente })) {
      await tx.update(execucoesAgente).set({ status: 'interrompida_pausa', finalizadoEm: t }).where(eq(execucoesAgente.id, execucaoId));
      await registrarAuditoria(tx, {
        ator, acao: 'execucao.interrompida', alvoTipo: 'execucao_agente', alvoId: execucaoId, detalhes: { motivo: 'pausado' },
      });
      return { avaliacao: { continuar: false, motivo: 'pausado', alertas: avaliacao.alertas }, demandaId: null };
    }
    if (avaliacao.continuar) return { avaliacao, demandaId: null };
    await tx.update(execucoesAgente).set({ status: 'interrompida_orcamento', finalizadoEm: t }).where(eq(execucoesAgente.id, execucaoId));
    await registrarAuditoria(tx, {
      ator, acao: 'execucao.interrompida', alvoTipo: 'execucao_agente', alvoId: execucaoId,
      detalhes: { motivo: avaliacao.motivo },
    });
    return { avaliacao, demandaId: e.demandaId };
  });

  if (demandaId !== null) {
    // Fora da transação (executarAcao abre a sua). A interrupção já está gravada.
    try {
      await executarAcao(db, demandaId, 'escalar', SISTEMA, `orcamento_excedido:${avaliacao.motivo}`);
    } catch (err) {
      if (!(err instanceof TransicaoInvalida) && !(err instanceof Pausado)) throw err;
    }
  }
  return avaliacao;
}

export async function finalizarExecucao(db: Db, execucaoId: string, status: 'concluida' | 'falhou'): Promise<void> {
  await db.transaction(async (tx) => {
    const [e] = await tx.select().from(execucoesAgente).where(eq(execucoesAgente.id, execucaoId)).for('update');
    if (!e) throw new ExecucaoNaoEncontrada(execucaoId);
    if (e.status !== 'em_andamento') throw new ExecucaoEncerrada(execucaoId, e.status);
    await tx.update(execucoesAgente).set({ status, finalizadoEm: new Date() }).where(eq(execucoesAgente.id, execucaoId));
    await registrarAuditoria(tx, {
      ator: `agente:${e.agente}`, acao: 'execucao.finalizada', alvoTipo: 'execucao_agente', alvoId: execucaoId, detalhes: { status },
    });
  });
}
