import { desc, eq } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { NewWorkflowVersion, WorkflowVersionRecord, WorkflowVersionRepository } from '@qa/application';
import type { Db } from './db';
import { workflowVersion } from './schema';

const toRecord = (r: typeof workflowVersion.$inferSelect): WorkflowVersionRecord => ({
  id: r.id,
  workflowId: r.workflowId,
  version: r.version,
  contentHash: r.contentHash,
  definition: r.definition,
  approvedBy: r.approvedBy,
  createdAt: r.createdAt,
});

export class PgWorkflowVersionRepository implements WorkflowVersionRepository {
  constructor(private readonly db: Db) {}

  async list(workflowId: string) {
    const rows = await this.db.select().from(workflowVersion).where(eq(workflowVersion.workflowId, workflowId)).orderBy(desc(workflowVersion.version));
    return rows.map(toRecord);
  }

  async latest(workflowId: string) {
    return (await this.list(workflowId))[0];
  }

  async insert(n: NewWorkflowVersion) {
    try {
      const [row] = await this.db.insert(workflowVersion).values({ id: n.id, workflowId: n.workflowId, version: n.version, contentHash: n.contentHash, definition: n.definition, approvedBy: n.approvedBy }).returning();
      return toRecord(row!);
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505') throw new PlatformError('conflict', 'That version already exists.');
      throw e;
    }
  }
}
