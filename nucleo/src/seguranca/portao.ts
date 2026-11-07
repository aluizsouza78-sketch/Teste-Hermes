import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/cliente.js';
import { aprovacoes, decisoesPolitica, demandas, servicosContratados } from '../db/schema.js';
import { registrarAuditoria } from '../auditoria/registrar.js';
import { DemandaNaoEncontrada } from '../esteira/servico.js';
import { autorizar, NIVEIS, type ConfigPolitica, type Decisao, type NivelAutonomia } from './politica.js';
import { estaPausado } from './pausas.js';

export const NIVEL_PADRAO: NivelAutonomia = 'N2';
const NIVEL_REBAIXADO: NivelAutonomia = 'N1';
const MOTIVOS_REBAIXAMENTO = new Set(['ferramenta_nao_permitida', 'escopo_cliente']);

function comoNivel(v: string): NivelAutonomia {
  if (!(NIVEIS as readonly string[]).includes(v)) throw new Error(`Nível de autonomia inválido: ${v}`);
  return v as NivelAutonomia;
}

/** Lê (e trava) o nível do cliente+serviço; ausente → N2. */
async function lerNivel(tx: Tx, clienteId: string, servicoId: string): Promise<NivelAutonomia> {
  const [r] = await tx
    .select({ nivel: servicosContratados.nivelAutonomia })
    .from(servicosContratados)
    .where(and(eq(servicosContratados.clienteId, clienteId), eq(servicosContratados.servicoId, servicoId)))
    .for('update');
  return r ? comoNivel(r.nivel) : NIVEL_PADRAO;
}

async function gravarNivel(tx: Tx, clienteId: string, servicoId: string, nivel: NivelAutonomia): Promise<void> {
  await tx
    .insert(servicosContratados)
    .values({ clienteId, servicoId, configuracao: {}, nivelAutonomia: nivel })
    .onConflictDoUpdate({
      target: [servicosContratados.clienteId, servicosContratados.servicoId],
      set: { nivelAutonomia: nivel },
    });
}

/**
 * Aplica o Portão a uma chamada de ferramenta de agente. O `clienteId` vem
 * sempre da demanda no banco, nunca dos argumentos.
 */
export function autorizarChamada(
  db: Db,
  config: ConfigPolitica,
  p: { demandaId: string; agente: string; ferramenta: string; argumentos: unknown },
): Promise<Decisao & { aprovacaoId?: string }> {
  return db.transaction(async (tx) => {
    const [demanda] = await tx
      .select({ id: demandas.id, clienteId: demandas.clienteId, servicoId: demandas.servicoId })
      .from(demandas)
      .where(eq(demandas.id, p.demandaId));
    if (!demanda) throw new DemandaNaoEncontrada(p.demandaId);

    const nivel = await lerNivel(tx, demanda.clienteId, demanda.servicoId);
    const pausado = await estaPausado(tx, { clienteId: demanda.clienteId, agente: p.agente });
    const decisao = autorizar(
      { agente: p.agente, clienteId: demanda.clienteId, nivel, pausado },
      { ferramenta: p.ferramenta, argumentos: p.argumentos },
      config,
    );

    await tx.insert(decisoesPolitica).values({
      demandaId: demanda.id,
      clienteId: demanda.clienteId,
      agente: p.agente,
      ferramenta: p.ferramenta,
      argumentos: p.argumentos ?? {},
      nivelAutonomia: nivel,
      decisao: decisao.decisao,
      motivo: decisao.motivo,
    });

    if (decisao.decisao === 'exigir_aprovacao') {
      const [ap] = await tx
        .insert(aprovacoes)
        .values({
          demandaId: demanda.id,
          tipo: 'acao',
          detalhes: { ferramenta: p.ferramenta, argumentos: p.argumentos },
        })
        .returning({ id: aprovacoes.id });
      await registrarAuditoria(tx, {
        ator: `agente:${p.agente}`,
        acao: 'aprovacao.aberta',
        alvoTipo: 'aprovacao',
        alvoId: ap.id,
        detalhes: { demandaId: demanda.id, tipo: 'acao', ferramenta: p.ferramenta, motivo: decisao.motivo },
      });
      return { ...decisao, aprovacaoId: ap.id };
    }

    // Violação: rebaixa para N1 (nunca eleva quem já está em N0/N1).
    if (decisao.decisao === 'negar' && MOTIVOS_REBAIXAMENTO.has(decisao.motivo)) {
      if (NIVEIS.indexOf(nivel) > NIVEIS.indexOf(NIVEL_REBAIXADO)) {
        await gravarNivel(tx, demanda.clienteId, demanda.servicoId, NIVEL_REBAIXADO);
        await registrarAuditoria(tx, {
          ator: 'sistema',
          acao: 'autonomia.rebaixada',
          alvoTipo: 'cliente',
          alvoId: demanda.clienteId,
          detalhes: {
            clienteId: demanda.clienteId,
            servicoId: demanda.servicoId,
            de: nivel,
            para: NIVEL_REBAIXADO,
            motivo: decisao.motivo,
          },
        });
      }
    }
    return decisao;
  });
}

export async function definirAutonomia(
  db: Db,
  clienteId: string,
  servicoId: string,
  nivel: NivelAutonomia,
  ator: 'operador',
  justificativa: string,
): Promise<void> {
  if (!justificativa.trim()) throw new Error('definirAutonomia exige justificativa');
  comoNivel(nivel);
  await db.transaction(async (tx) => {
    const de = await lerNivel(tx, clienteId, servicoId);
    await gravarNivel(tx, clienteId, servicoId, nivel);
    await registrarAuditoria(tx, {
      ator,
      acao: 'autonomia.definida',
      alvoTipo: 'cliente',
      alvoId: clienteId,
      detalhes: { clienteId, servicoId, de, para: nivel, justificativa },
    });
  });
}
