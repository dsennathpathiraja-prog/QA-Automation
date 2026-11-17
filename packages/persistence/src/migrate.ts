import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from './db';

export const DEFAULT_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface Journal {
  entries: { idx: number; tag: string }[];
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Applies the drizzle-kit journal in order, each migration in its own transaction. Concurrent starters
 * (api and worker) serialise on an advisory lock. An already-applied migration whose file has changed
 * aborts the run: migrations are immutable once released.
 */
export async function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationResult> {
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as Journal;
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(727274)`);
    await tx.execute(sql`create table if not exists qa_migration (tag text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
    const done = new Map<string, string>();
    const rows = await tx.execute(sql`select tag, sha256 from qa_migration`);
    for (const r of (rows as unknown as { rows: { tag: string; sha256: string }[] }).rows) done.set(r.tag, r.sha256);

    for (const e of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
      const text = readFileSync(join(dir, `${e.tag}.sql`), 'utf8');
      const digest = sha(text);
      const prior = done.get(e.tag);
      if (prior) {
        if (prior !== digest) throw new Error(`migration ${e.tag} was modified after it was applied`);
        result.alreadyApplied.push(e.tag);
        continue;
      }
      for (const stmt of text.split('--> statement-breakpoint')) {
        if (stmt.trim().length > 0) await tx.execute(sql.raw(stmt));
      }
      await tx.execute(sql`insert into qa_migration (tag, sha256) values (${e.tag}, ${digest})`);
      result.applied.push(e.tag);
    }
  });
  return result;
}
