import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

/** Banco tipado com o schema; compatível com node-postgres e PGlite. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
/** Transação Drizzle; aceita onde se escreve via Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function criarDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url });
  return drizzlePg(pool, { schema }) as unknown as Db;
}

export async function criarDbTeste(): Promise<Db> {
  const client = new PGlite();
  const db = drizzlePglite(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
  return db as unknown as Db;
}
