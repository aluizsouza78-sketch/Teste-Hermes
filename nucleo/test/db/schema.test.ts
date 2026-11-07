import { describe, it, expect } from 'vitest';
import { criarDbTeste } from '../../src/db/cliente.js';
import { auditoria, canaisCliente, clientes, decisoesPolitica, demandas, eventos } from '../../src/db/schema.js';
import { registrarAuditoria } from '../../src/auditoria/registrar.js';

// Drizzle envolve o erro do driver em DrizzleQueryError; a mensagem do banco fica em `cause`.
const somenteInsercao = { cause: { message: expect.stringMatching(/somente inser/) } };

describe('schema', () => {
  it('canal não pode pertencer a dois clientes', async () => {
    const db = await criarDbTeste();
    const [a] = await db.insert(clientes).values({ nome: 'A' }).returning();
    const [b] = await db.insert(clientes).values({ nome: 'B' }).returning();
    await db.insert(canaisCliente).values({ clienteId: a.id, tipo: 'whatsapp_grupo', identificador: 'g1' });
    await expect(
      db.insert(canaisCliente).values({ clienteId: b.id, tipo: 'whatsapp_grupo', identificador: 'g1' }),
    ).rejects.toThrow();
  });

  it('auditoria rejeita UPDATE e DELETE', async () => {
    const db = await criarDbTeste();
    await registrarAuditoria(db, { ator: 'operador', acao: 'teste', alvoTipo: 'nada' });
    await expect(db.update(auditoria).set({ acao: 'x' })).rejects.toMatchObject(somenteInsercao);
    await expect(db.delete(auditoria)).rejects.toMatchObject(somenteInsercao);
  });

  it('decisoes_politica rejeita UPDATE e DELETE', async () => {
    const db = await criarDbTeste();
    const [c] = await db.insert(clientes).values({ nome: 'A' }).returning();
    const [d] = await db
      .insert(demandas)
      .values({ clienteId: c.id, servicoId: 's', etapa: 'recebida', titulo: 't' })
      .returning();
    await db.insert(decisoesPolitica).values({
      demandaId: d.id,
      clienteId: c.id,
      agente: 'ag',
      ferramenta: 'f',
      argumentos: {},
      nivelAutonomia: 'N2',
      decisao: 'permitir',
      motivo: 'ok',
    });
    await expect(db.update(decisoesPolitica).set({ motivo: 'x' })).rejects.toMatchObject(somenteInsercao);
    await expect(db.delete(decisoesPolitica)).rejects.toMatchObject(somenteInsercao);
  });

  it('evento duplicado (mesmo canal_tipo + id_externo) é rejeitado pelo banco', async () => {
    const db = await criarDbTeste();
    const e = {
      canalTipo: 'whatsapp_grupo',
      canalIdentificador: 'g1',
      idExterno: 'm1',
      texto: 'oi',
      status: 'recebido',
    };
    await db.insert(eventos).values(e);
    await expect(db.insert(eventos).values(e)).rejects.toThrow();
  });
});
