import { asc, desc, gt, sql } from 'drizzle-orm';
import { GENESIS_HASH, chainEntry, type AuditEntry, type AuditEntryInput } from '@qa/security';
import type { Db } from './db';
import { auditLog } from './schema';

type Row = typeof auditLog.$inferSelect;
const toEntry = (r: Row): AuditEntry => ({
  seq: r.seq,
  at: r.at,
  actorId: r.actorId,
  action: r.action,
  subjectType: r.subjectType,
  subjectId: r.subjectId ?? undefined,
  detail: r.detail ?? undefined,
  prevHash: r.prevHash,
  hash: r.hash,
});

const AUDIT_LOCK = 727275;

export class PgAuditLog {
  constructor(private readonly db: Db) {}

  /** Chained append. The advisory lock serialises writers across processes so the chain cannot fork. */
  async append(input: AuditEntryInput): Promise<AuditEntry> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`);
      const last = await tx.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(1);
      const entry = chainEntry(last[0] ? toEntry(last[0]) : undefined, input);
      await tx.insert(auditLog).values({
        seq: entry.seq,
        at: entry.at,
        actorId: entry.actorId,
        action: entry.action,
        subjectType: entry.subjectType,
        subjectId: entry.subjectId ?? null,
        detail: entry.detail ?? null,
        prevHash: entry.prevHash,
        hash: entry.hash,
      });
      return entry;
    });
  }

  async recent(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.db.select().from(auditLog).orderBy(desc(auditLog.seq)).limit(limit);
    return rows.map(toEntry);
  }

  /** Walks the whole chain in pages. Returns the first broken sequence number, if any. */
  async verify(pageSize = 1000): Promise<{ ok: true; entries: number } | { ok: false; brokenAtSeq: number }> {
    let prev: AuditEntry | undefined;
    let after = 0;
    let count = 0;
    for (;;) {
      const rows = await this.db.select().from(auditLog).where(gt(auditLog.seq, after)).orderBy(asc(auditLog.seq)).limit(pageSize);
      if (rows.length === 0) return { ok: true, entries: count };
      for (const r of rows) {
        const e = toEntry(r);
        const { seq: _s, prevHash: _p, hash: _h, ...input } = e;
        const expected = chainEntry(prev, input);
        if (e.seq !== expected.seq || e.prevHash !== (prev?.hash ?? GENESIS_HASH) || e.hash !== expected.hash) return { ok: false, brokenAtSeq: e.seq };
        prev = e;
        count += 1;
      }
      after = rows.at(-1)!.seq;
    }
  }
}
