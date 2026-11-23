import { PlatformError } from '@qa/domain';
import type { NewWorkflow, NewWorkflowVersion, WorkflowRecord, WorkflowRepository, WorkflowVersionRecord, WorkflowVersionRepository } from '@qa/application';

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly rows = new Map<string, WorkflowRecord>();

  async list(filter?: { projectId?: string }) {
    return [...this.rows.values()]
      .filter((r) => !filter?.projectId || r.projectId === filter.projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async insert(n: NewWorkflow) {
    if ([...this.rows.values()].some((r) => r.projectId === n.projectId && r.key === n.key)) {
      throw new PlatformError('conflict', `A workflow with key "${n.key}" already exists in this project.`);
    }
    const now = new Date();
    const rec: WorkflowRecord = {
      id: n.id,
      projectId: n.projectId,
      key: n.key,
      name: n.name,
      description: n.description,
      type: n.type,
      status: 'draft',
      enabled: true,
      definition: structuredClone(n.definition),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(rec.id, rec);
    return structuredClone(rec);
  }

  async update(id: string, patch: { name?: string; description?: string; enabled?: boolean; status?: WorkflowRecord['status']; definition?: Record<string, unknown> }) {
    const row = this.rows.get(id);
    if (!row) throw new PlatformError('not-found', 'Workflow not found');
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.definition !== undefined) row.definition = structuredClone(patch.definition);
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async softDelete(id: string) {
    this.rows.delete(id);
  }
}

export class InMemoryWorkflowVersionRepository implements WorkflowVersionRepository {
  readonly rows: WorkflowVersionRecord[] = [];

  async list(workflowId: string) {
    return this.rows.filter((r) => r.workflowId === workflowId).sort((a, b) => b.version - a.version).map((r) => structuredClone(r));
  }

  async latest(workflowId: string) {
    return (await this.list(workflowId))[0];
  }

  async insert(n: NewWorkflowVersion) {
    if (this.rows.some((r) => r.workflowId === n.workflowId && r.version === n.version)) throw new PlatformError('conflict', 'That version already exists.');
    const rec: WorkflowVersionRecord = { ...n, definition: structuredClone(n.definition), createdAt: new Date() };
    this.rows.push(rec);
    return structuredClone(rec);
  }
}
