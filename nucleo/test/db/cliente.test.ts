import { describe, it, expect, vi, afterEach } from 'vitest';
import type pg from 'pg';
import { criarDb } from '../../src/db/cliente.js';

describe('criarDb (node-postgres)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('erro em conexão ociosa do pool é registrado, não derruba o processo', async () => {
    // Nenhuma conexão é aberta: o Pool só conecta na primeira consulta.
    const db = criarDb('postgres://ninguem@127.0.0.1:1/nada');
    const pool = (db as unknown as { $client: pg.Pool }).$client;
    const espiao = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', new Error('conexão caiu'))).not.toThrow();
    expect(espiao).toHaveBeenCalledOnce();
    expect(String(espiao.mock.calls[0].join(' '))).toContain('conexão caiu');
    await pool.end();
  });
});
