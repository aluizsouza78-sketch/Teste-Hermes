import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { criarDbTeste } from '../../src/db/cliente.js';
import { auditoria } from '../../src/db/schema.js';
import { registrarAuditoria } from '../../src/auditoria/registrar.js';

describe('registrarAuditoria', () => {
  it('grava registro com defaults', async () => {
    const db = await criarDbTeste();
    await registrarAuditoria(db, { ator: 'sistema', acao: 'criar', alvoTipo: 'cliente' });
    const [r] = await db.select().from(auditoria);
    expect(r).toMatchObject({ ator: 'sistema', acao: 'criar', alvoTipo: 'cliente', alvoId: null, detalhes: {}, credencialRef: null });
  });

  it('funciona dentro de transação e grava detalhes', async () => {
    const db = await criarDbTeste();
    const id = '00000000-0000-4000-8000-000000000001';
    await db.transaction(async (tx) => {
      await registrarAuditoria(tx, { ator: 'operador', acao: 'aprovar', alvoTipo: 'demanda', alvoId: id, detalhes: { x: 1 }, credencialRef: 'cofre://a' });
    });
    const rs = await db.select().from(auditoria).where(eq(auditoria.alvoId, id));
    expect(rs).toHaveLength(1);
    expect(rs[0].detalhes).toEqual({ x: 1 });
    expect(rs[0].credencialRef).toBe('cofre://a');
  });
});
