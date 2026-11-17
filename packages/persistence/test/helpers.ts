import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate, schema, seedDefaultGroupMappings, seedRoles, type Db } from '../src';

/** Real Postgres semantics (WASM build) with no server: constraints, triggers and partial indexes are exercised for real. */
export async function freshDb(opts: { seed?: boolean } = {}): Promise<{ db: Db; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  await migrate(db);
  if (opts.seed !== false) {
    await seedRoles(db);
    await seedDefaultGroupMappings(db);
  }
  return { db, client };
}
