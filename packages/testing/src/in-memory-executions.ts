import { PlatformError } from '@qa/domain';
import type { ExecutionEvent, ExecutionRecord, ExecutionRepository, NewExecution } from '@qa/application';

export class InMemoryExecutionRepository implements ExecutionRepository {
  readonly rows = new Map<string, ExecutionRecord>();
  readonly log = new Map<string, ExecutionEvent[]>();

  async insert(n: NewExecution) {
    const now = new Date();
    const rec: ExecutionRecord = { id: n.id, workflowId: n.workflowId, versionId: n.versionId, status: 'queued', stepIndex: 0, control: null, createdAt: now, updatedAt: now };
    this.rows.set(rec.id, rec);
    this.log.set(rec.id, [{ seq: 1, kind: 'started', payload: {}, at: now.toISOString() }]);
    return structuredClone(rec);
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async listForWorkflow(workflowId: string) {
    return [...this.rows.values()].filter((r) => r.workflowId === workflowId).map((r) => structuredClone(r));
  }

  async listRecent(limit: number) {
    return [...this.rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit).map((r) => structuredClone(r));
  }

  async events(id: string) {
    return structuredClone(this.log.get(id) ?? []);
  }

  async apply(id: string, patch: { status?: ExecutionRecord['status']; control?: ExecutionRecord['control']; leaseOwner?: string | null; leaseUntil?: Date | null }) {
    const row = this.rows.get(id);
    if (!row) throw new PlatformError('not-found', 'Run not found');
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.control !== undefined) row.control = patch.control;
    row.updatedAt = new Date();
    return structuredClone(row);
  }
}
