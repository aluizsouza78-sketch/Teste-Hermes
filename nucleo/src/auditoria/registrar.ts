import type { Db, Tx } from '../db/cliente.js';
import { auditoria } from '../db/schema.js';

export interface EventoAuditoria {
  ator: string;
  acao: string;
  alvoTipo: string;
  alvoId?: string;
  detalhes?: Record<string, unknown>;
  credencialRef?: string;
}

export async function registrarAuditoria(db: Db | Tx, e: EventoAuditoria): Promise<void> {
  await db.insert(auditoria).values({
    ator: e.ator,
    acao: e.acao,
    alvoTipo: e.alvoTipo,
    alvoId: e.alvoId ?? null,
    detalhes: e.detalhes ?? {},
    credencialRef: e.credencialRef ?? null,
  });
}
