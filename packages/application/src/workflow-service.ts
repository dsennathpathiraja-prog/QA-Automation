import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { ActorRef } from './connector-service';
import type { AuditSink } from './ports';

export const WORKFLOW_TYPES = ['requirement-validation', 'regression-testing'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

export interface WorkflowRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  type: WorkflowType;
  status: 'draft' | 'disabled';
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWorkflow {
  id: string;
  key: string;
  name: string;
  description: string;
  type: WorkflowType;
  definition: Record<string, unknown>;
}

export interface WorkflowRepository {
  list(): Promise<WorkflowRecord[]>;
  get(id: string): Promise<WorkflowRecord | undefined>;
  insert(rec: NewWorkflow): Promise<WorkflowRecord>;
  update(id: string, patch: { name?: string; description?: string; enabled?: boolean; status?: 'draft' | 'disabled' }): Promise<WorkflowRecord>;
  softDelete(id: string): Promise<void>;
}

export interface WorkflowView {
  id: string;
  key: string;
  name: string;
  description: string;
  type: WorkflowType;
  status: 'draft' | 'disabled';
  enabled: boolean;
  updatedAt: string;
}

const view = (r: WorkflowRecord): WorkflowView => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  type: r.type,
  status: r.status,
  enabled: r.enabled,
  updatedAt: r.updatedAt.toISOString(),
});

export class WorkflowService {
  constructor(private readonly d: { workflows: WorkflowRepository; audit: AuditSink }) {}

  async list(includeDrafts: boolean): Promise<WorkflowView[]> {
    const rows = await this.d.workflows.list();
    return rows.filter((r) => includeDrafts || r.status !== 'draft').map(view);
  }

  async get(id: string, includeDrafts: boolean): Promise<WorkflowView> {
    const row = await this.require(id);
    if (row.status === 'draft' && !includeDrafts) throw new PlatformError('not-found', 'Workflow not found');
    return view(row);
  }

  async create(actor: ActorRef, input: { name: string; type: string; description?: string; key?: string }): Promise<WorkflowView> {
    const name = this.name(input.name);
    const type = this.kind(input.type);
    const key = this.key(input.key ?? name);
    const description = (input.description ?? '').trim().slice(0, 500);
    const rec = await this.d.workflows.insert({ id: randomUUID(), key, name, description, type, definition: shell(key, name, description, type) });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.create', subjectType: 'workflow', subjectId: rec.id, detail: { key, type } });
    return view(rec);
  }

  async update(actor: ActorRef, id: string, input: { name?: string; description?: string }): Promise<WorkflowView> {
    const current = await this.require(id);
    if (current.status !== 'draft') throw new PlatformError('conflict', 'Only a draft can be edited. Published versions are a later step.');
    const name = input.name === undefined ? undefined : this.name(input.name);
    const description = input.description === undefined ? undefined : input.description.trim().slice(0, 500);
    const rec = await this.d.workflows.update(id, { name, description });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.update', subjectType: 'workflow', subjectId: id, detail: { name: rec.name } });
    return view(rec);
  }

  async disable(actor: ActorRef, id: string): Promise<WorkflowView> {
    await this.require(id);
    const rec = await this.d.workflows.update(id, { enabled: false, status: 'disabled' });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.disable', subjectType: 'workflow', subjectId: id });
    return view(rec);
  }

  async remove(actor: ActorRef, id: string): Promise<void> {
    const rec = await this.require(id);
    if (rec.enabled && rec.status !== 'disabled') throw new PlatformError('conflict', 'Disable this workflow before removing it.');
    await this.d.workflows.softDelete(id);
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.delete', subjectType: 'workflow', subjectId: id, detail: { key: rec.key } });
  }

  private async require(id: string) {
    const row = await this.d.workflows.get(id);
    if (!row) throw new PlatformError('not-found', 'Workflow not found');
    return row;
  }

  private name(raw: string) {
    const name = raw.trim();
    if (name.length < 1 || name.length > 120) throw new PlatformError('validation', 'Name must be between 1 and 120 characters.');
    return name;
  }

  private kind(raw: string): WorkflowType {
    if (!(WORKFLOW_TYPES as readonly string[]).includes(raw)) throw new PlatformError('validation', 'Type must be requirement validation or regression testing.');
    return raw as WorkflowType;
  }

  private key(raw: string) {
    const key = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (key.length < 1 || key.length > 80) throw new PlatformError('validation', 'Key must be a short slug, such as checkout-rv.');
    return key;
  }
}

function shell(key: string, name: string, description: string, type: WorkflowType): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kind: 'WorkflowDefinition',
    metadata: { key, name, description, type, typeVersion: 1, templateRef: null },
    spec: {
      parameters: [],
      connectors: [],
      environment: { mode: 'required', allowedKinds: ['development', 'qa', 'staging', 'uat'], pinnedEnvironmentId: null, production: { allowed: false, requiresApproval: true } },
      execution: { maxParallelism: 1, timeoutMinutes: 60, onStepFailure: 'stop', schedule: null, retention: { artifactDays: 30 } },
      approvals: [],
      policy: { capabilityDeny: [] },
      steps: [],
    },
  };
}
