import { describe, it, expect, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type pg from 'pg';
import { criarDb, type Db } from '../../src/db/cliente.js';
import { aprovacoes } from '../../src/db/schema.js';
import { criarCliente } from '../../src/clientes/repositorio.js';
import { criarDemanda, decidirAprovacao, executarAcao, obterDemanda } from '../../src/esteira/servico.js';

/**
 * Smoke test em Postgres real (node-postgres, FOR UPDATE, triggers, jsonb).
 * Só roda com DATABASE_URL_TESTE_PG apontando para um banco já migrado
 * (`npx drizzle-kit migrate`); localmente, sem a variável, é pulado.
 */
const url = process.env.DATABASE_URL_TESTE_PG;

describe.skipIf(!url)('Postgres real (smoke)', () => {
  let db: Db | undefined;
  afterAll(async () => {
    if (db) await (db as unknown as { $client: pg.Pool }).$client.end();
  });

  it('cliente → demanda → submeter_escopo → aprovar → construcao', async () => {
    db = criarDb(url!);
    const cliente = await criarCliente(db, { nome: `Smoke ${Date.now()}` }, 'operador');
    const demanda = await criarDemanda(
      db,
      { clienteId: cliente.id, servicoId: 'sob-medida', titulo: 'Smoke' },
      { tipo: 'operador' },
    );
    const e1 = await executarAcao(db, demanda.id, 'submeter_escopo', { tipo: 'agente', nome: 'gestor' });
    expect(e1.etapa).toBe('aguardando_aprovacao_escopo');

    const [ap] = await db
      .select({ id: aprovacoes.id })
      .from(aprovacoes)
      .where(and(eq(aprovacoes.demandaId, demanda.id), eq(aprovacoes.status, 'pendente')));
    expect(ap).toBeDefined();
    const e2 = await decidirAprovacao(db, ap.id, 'aprovar', 'smoke');
    expect(e2.etapa).toBe('construcao');
    expect((await obterDemanda(db, demanda.id)).etapa).toBe('construcao');
  });
});
