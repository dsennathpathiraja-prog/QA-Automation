import { eq } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { ApprovedHost, ApprovedHostRepository } from '@qa/application';
import type { Db } from './db';
import { egressAllowlist } from './schema';

type Row = typeof egressAllowlist.$inferSelect;

const toHost = (r: Row): ApprovedHost => ({
  id: r.id,
  hostPattern: r.hostPattern,
  purpose: r.purpose as ApprovedHost['purpose'],
  internal: r.internal,
  allowHttp: r.allowHttp,
  approvedAt: r.approvedAt,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgApprovedHostRepository implements ApprovedHostRepository {
  constructor(private readonly db: Db) {}

  async list(purpose?: ApprovedHost['purpose']): Promise<ApprovedHost[]> {
    const q = this.db.select().from(egressAllowlist);
    const rows = await (purpose ? q.where(eq(egressAllowlist.purpose, purpose)) : q).orderBy(egressAllowlist.hostPattern, egressAllowlist.purpose);
    return rows.map(toHost);
  }

  async add(h: Parameters<ApprovedHostRepository['add']>[0]): Promise<ApprovedHost> {
    try {
      const [row] = await this.db
        .insert(egressAllowlist)
        .values({ hostPattern: h.hostPattern, purpose: h.purpose, internal: h.internal, allowHttp: h.allowHttp })
        .returning();
      return toHost(row!);
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') throw new PlatformError('conflict', 'This host is already approved.');
      throw e;
    }
  }

  async remove(id: string): Promise<ApprovedHost | undefined> {
    if (!UUID.test(id)) return undefined;
    const [row] = await this.db.delete(egressAllowlist).where(eq(egressAllowlist.id, id)).returning();
    return row && toHost(row);
  }
}

