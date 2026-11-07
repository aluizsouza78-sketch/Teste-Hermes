import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db, Tx } from '../db/cliente.js';
import { pausas } from '../db/schema.js';
import { registrarAuditoria } from '../auditoria/registrar.js';

export type EscopoPausa = 'global' | 'cliente' | 'agente';

/** Lançado quando um agente tenta agir com uma pausa de emergência ativa. */
export class Pausado extends Error {
  constructor(readonly clienteId: string, readonly agente: string) {
    super(`Pausa de emergência ativa: agente ${agente} bloqueado (cliente ${clienteId})`);
    this.name = 'Pausado';
  }
}

export class PausaNaoEncontrada extends Error {
  constructor(readonly pausaId: string) {
    super(`Pausa não encontrada: ${pausaId}`);
    this.name = 'PausaNaoEncontrada';
  }
}

export class PausaJaEncerrada extends Error {
  constructor(readonly pausaId: string) {
    super(`Pausa ${pausaId} já encerrada`);
    this.name = 'PausaJaEncerrada';
  }
}

export async function pausar(
  db: Db,
  p: { escopo: EscopoPausa; alvo?: string; motivo: string },
): Promise<{ id: string }> {
  const alvo = p.alvo?.trim() || undefined;
  if (p.escopo === 'global' && alvo !== undefined) throw new Error('Pausa global não aceita alvo');
  if (p.escopo !== 'global' && alvo === undefined) throw new Error(`Pausa por ${p.escopo} exige alvo`);
  if (!p.motivo.trim()) throw new Error('Pausa exige motivo');
  return db.transaction(async (tx) => {
    const [r] = await tx
      .insert(pausas)
      .values({ escopo: p.escopo, alvo: alvo ?? null, motivo: p.motivo })
      .returning({ id: pausas.id });
    await registrarAuditoria(tx, {
      ator: 'operador',
      acao: 'pausa.criada',
      alvoTipo: 'pausa',
      alvoId: r.id,
      detalhes: { escopo: p.escopo, ...(alvo !== undefined ? { alvo } : {}), motivo: p.motivo },
    });
    return { id: r.id };
  });
}

export async function encerrarPausa(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(pausas).where(eq(pausas.id, id)).for('update');
    if (!p) throw new PausaNaoEncontrada(id);
    if (p.encerradaEm !== null) throw new PausaJaEncerrada(id);
    await tx.update(pausas).set({ encerradaEm: new Date() }).where(eq(pausas.id, id));
    await registrarAuditoria(tx, {
      ator: 'operador',
      acao: 'pausa.encerrada',
      alvoTipo: 'pausa',
      alvoId: id,
      detalhes: { escopo: p.escopo, ...(p.alvo !== null ? { alvo: p.alvo } : {}) },
    });
  });
}

/** Verdadeiro se houver pausa aberta global, do cliente ou do agente. */
export async function estaPausado(db: Db | Tx, p: { clienteId: string; agente: string }): Promise<boolean> {
  const [r] = await db
    .select({ id: pausas.id })
    .from(pausas)
    .where(
      and(
        isNull(pausas.encerradaEm),
        or(
          eq(pausas.escopo, 'global'),
          and(eq(pausas.escopo, 'cliente'), eq(pausas.alvo, p.clienteId)),
          and(eq(pausas.escopo, 'agente'), eq(pausas.alvo, p.agente)),
        ),
      ),
    )
    .limit(1);
  return r !== undefined;
}
