import { PlatformError } from '@qa/domain';
import type { NewWorkflow, WorkflowRecord, WorkflowRepository } from '@qa/application';

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly rows = new Map<string, WorkflowRecord>();

  async list() {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async insert(n: NewWorkflow) {
    if ([...this.rows.values()].some((r) => r.key === n.key)) throw new PlatformError('conflict', `A workflow with key "${n.key}" already exists.`);
    const now = new Date();
    const rec: WorkflowRecord = { id: n.id, key: n.key, name: n.name, description: n.description, type: n.type, status: 'draft', enabled: true, createdAt: now, updatedAt: now };
    this.rows.set(rec.id, rec);
    return structuredClone(rec);
  }

  async update(id: string, patch: { name?: string; description?: string; enabled?: boolean; status?: WorkflowRecord['status'] }) {
    const row = this.rows.get(id);
    if (!row) throw new PlatformError('not-found', 'Workflow not found');
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.status !== undefined) row.status = patch.status;
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async softDelete(id: string) {
    this.rows.delete(id);
  }
}
