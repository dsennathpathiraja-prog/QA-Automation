import { and, eq, isNull, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { NewWorkflow, WorkflowRecord, WorkflowRepository, WorkflowType } from '@qa/application';
import type { Db } from './db';
import { workflow } from './schema';

const unique = (e: unknown) => ((e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code) === '23505';
const live = (id: string) => and(eq(workflow.id, id), isNull(workflow.deletedAt));

const toRecord = (r: typeof workflow.$inferSelect): WorkflowRecord => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  type: r.type as WorkflowType,
  status: r.status as WorkflowRecord['status'],
  enabled: r.enabled,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class PgWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db.select().from(workflow).where(isNull(workflow.deletedAt)).orderBy(workflow.name);
    return rows.map(toRecord);
  }

  async get(id: string) {
    const [row] = await this.db.select().from(workflow).where(live(id)).limit(1);
    return row && toRecord(row);
  }

  async insert(n: NewWorkflow) {
    try {
      const [row] = await this.db.insert(workflow).values({ id: n.id, key: n.key, name: n.name, description: n.description, type: n.type, definition: n.definition, status: 'draft' }).returning();
      return toRecord(row!);
    } catch (e) {
      if (unique(e)) throw new PlatformError('conflict', `A workflow with key "${n.key}" already exists.`);
      throw e;
    }
  }

  async update(id: string, patch: { name?: string; description?: string; enabled?: boolean; status?: 'draft' | 'disabled' }) {
    const set: Partial<typeof workflow.$inferInsert> = { updatedAt: new Date(), rowVersion: sql`${workflow.rowVersion} + 1` as unknown as number };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.status !== undefined) set.status = patch.status;
    const [row] = await this.db.update(workflow).set(set).where(live(id)).returning();
    if (!row) throw new PlatformError('not-found', 'Workflow not found');
    return toRecord(row);
  }

  async softDelete(id: string) {
    await this.db.update(workflow).set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() }).where(live(id));
  }
}
