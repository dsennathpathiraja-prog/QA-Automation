import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PgConnection {
  db: Db;
  close(): Promise<void>;
}

export function connectPostgres(opts: { url?: string; host?: string; port?: number; database?: string; user?: string; password?: string; max?: number }): PgConnection {
  const pool = new pg.Pool({
    connectionString: opts.url,
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', () => undefined);
  return { db: drizzle(pool, { schema }) as unknown as Db, close: () => pool.end() };
}

export async function pingDb(db: Db): Promise<boolean> {
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`select 1`);
  return true;
}
