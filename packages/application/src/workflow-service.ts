import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import { TEMPLATES, contentHash, errorsOf, templateDefinition, validateWorkflow, type BoundInstance, type ValidationIssue, type WfDef } from '@qa/workflow-definitions';
import type { ActorRef } from './connector-service';
import type { AuditSink, ConnectorRepository } from './ports';

export const WORKFLOW_TYPES = ['requirement-validation', 'regression-testing'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export type WorkflowStatus = 'draft' | 'in_review' | 'published' | 'disabled';

export interface WorkflowRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  type: WorkflowType;
  status: WorkflowStatus;
  enabled: boolean;
  definition: Record<string, unknown>;
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
  update(id: string, patch: { name?: string; description?: string; enabled?: boolean; status?: WorkflowStatus; definition?: Record<string, unknown> }): Promise<WorkflowRecord>;
  softDelete(id: string): Promise<void>;
}

export interface WorkflowVersionRecord {
  id: string;
  workflowId: string;
  version: number;
  contentHash: string;
  definition: Record<string, unknown>;
  approvedBy: string;
  createdAt: Date;
}

export interface NewWorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  contentHash: string;
  definition: Record<string, unknown>;
  approvedBy: string;
}

export interface WorkflowVersionRepository {
  list(workflowId: string): Promise<WorkflowVersionRecord[]>;
  latest(workflowId: string): Promise<WorkflowVersionRecord | undefined>;
  insert(rec: NewWorkflowVersion): Promise<WorkflowVersionRecord>;
}

export type ExecutionStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  versionId: string;
  status: ExecutionStatus;
  stepIndex: number;
  control: 'pause' | 'cancel' | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewExecution {
  id: string;
  workflowId: string;
  versionId: string;
  definition: Record<string, unknown>;
  params: Record<string, unknown>;
}

export interface ExecutionEvent {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface ExecutionRepository {
  insert(rec: NewExecution): Promise<ExecutionRecord>;
  get(id: string): Promise<ExecutionRecord | undefined>;
  listForWorkflow(workflowId: string): Promise<ExecutionRecord[]>;
  listRecent(limit: number): Promise<ExecutionRecord[]>;
  events(id: string): Promise<ExecutionEvent[]>;
  apply(id: string, patch: { status?: ExecutionStatus; control?: ExecutionRecord['control']; leaseOwner?: string | null; leaseUntil?: Date | null }): Promise<ExecutionRecord>;
}

export interface WorkflowView {
  id: string;
  key: string;
  name: string;
  description: string;
  type: WorkflowType;
  status: WorkflowStatus;
  enabled: boolean;
  updatedAt: string;
  publishedVersion: number | null;
}

export interface ExecutionView {
  id: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionStatus;
  stepIndex: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentCheck {
  kind: string;
  enabled: boolean;
  productionAuthorized: boolean;
}

const viewOf = (r: WorkflowRecord, publishedVersion: number | null): WorkflowView => ({
  id: r.id, key: r.key, name: r.name, description: r.description, type: r.type, status: r.status, enabled: r.enabled, updatedAt: r.updatedAt.toISOString(), publishedVersion,
});

const runOf = (r: ExecutionRecord, workflowName = ''): ExecutionView => ({
  id: r.id, workflowId: r.workflowId, workflowName, status: r.status, stepIndex: r.stepIndex, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

const asDef = (value: Record<string, unknown>) => value as unknown as WfDef;

export class WorkflowService {
  constructor(private readonly d: {
    workflows: WorkflowRepository;
    audit: AuditSink;
    versions?: WorkflowVersionRepository;
    executions?: ExecutionRepository;
    connectors?: ConnectorRepository;
    environment?: (id: string) => Promise<EnvironmentCheck | null>;
  }) {}

  templates() {
    return TEMPLATES.map((t) => ({ key: t.key, name: t.name, type: t.type, summary: t.summary }));
  }

  async list(includeDrafts: boolean): Promise<WorkflowView[]> {
    const rows = (await this.d.workflows.list()).filter((r) => includeDrafts || r.status === 'published');
    return Promise.all(rows.map((r) => this.present(r)));
  }

  async get(id: string, includeDrafts: boolean): Promise<WorkflowView> {
    const row = await this.require(id);
    if (row.status !== 'published' && !includeDrafts) throw new PlatformError('not-found', 'Workflow not found');
    return this.present(row);
  }

  async definition(id: string, includeDrafts: boolean): Promise<Record<string, unknown>> {
    const row = await this.require(id);
    if (row.status !== 'published' && !includeDrafts) throw new PlatformError('not-found', 'Workflow not found');
    return row.definition;
  }

  async create(actor: ActorRef, input: { name: string; type: string; description?: string; key?: string; templateKey?: string }): Promise<WorkflowView> {
    const name = this.name(input.name);
    const type = this.kind(input.type);
    const key = this.key(input.key ?? name);
    const description = (input.description ?? '').trim().slice(0, 500);
    const template = input.templateKey ? templateDefinition(input.templateKey) : undefined;
    if (input.templateKey && !template) throw new PlatformError('validation', 'That template does not exist.');
    if (template && template.metadata.type !== type) throw new PlatformError('validation', 'That template is a different workflow type.');
    const definition: WfDef = template ?? (shell(key, name, description, type) as unknown as WfDef);
    if (template) {
      definition.metadata.key = key;
      definition.metadata.name = name;
      definition.metadata.description = description;
      definition.metadata.templateRef = { key: input.templateKey!, version: 1 };
    }
    const rec = await this.d.workflows.insert({ id: randomUUID(), key, name, description, type, definition: definition as unknown as Record<string, unknown> });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.create', subjectType: 'workflow', subjectId: rec.id, detail: { key, type, template: input.templateKey ?? null } });
    return this.present(rec);
  }

  async update(actor: ActorRef, id: string, input: { name?: string; description?: string }): Promise<WorkflowView> {
    const current = await this.editable(id);
    const name = input.name === undefined ? undefined : this.name(input.name);
    const description = input.description === undefined ? undefined : input.description.trim().slice(0, 500);
    const definition = structuredClone(current.definition);
    const meta = definition.metadata;
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>;
      if (name !== undefined) m.name = name;
      if (description !== undefined) m.description = description;
    }
    const rec = await this.d.workflows.update(id, { name, description, definition });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.update', subjectType: 'workflow', subjectId: id, detail: { name: rec.name } });
    return this.present(rec);
  }

  async saveDefinition(actor: ActorRef, id: string, definition: Record<string, unknown>): Promise<WorkflowView> {
    const current = await this.editable(id);
    if (definition.schemaVersion !== '1.0' || definition.kind !== 'WorkflowDefinition') throw new PlatformError('validation', 'The definition must be a workflow definition, schema 1.0.');
    const next = structuredClone(definition);
    const meta = (next.metadata && typeof next.metadata === 'object' ? next.metadata : {}) as Record<string, unknown>;
    meta.key = current.key;
    meta.name = current.name;
    meta.description = current.description;
    meta.type = current.type;
    next.metadata = meta;
    const rec = await this.d.workflows.update(id, { definition: next });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.update', subjectType: 'workflow', subjectId: id, detail: { definition: true } });
    return this.present(rec);
  }

  async validate(id: string, includeDrafts: boolean): Promise<ValidationIssue[]> {
    const row = await this.require(id);
    if (row.status !== 'published' && !includeDrafts) throw new PlatformError('not-found', 'Workflow not found');
    return this.report(row.definition);
  }

  async requestPublish(actor: ActorRef, id: string): Promise<WorkflowView> {
    const current = await this.require(id);
    if (current.status !== 'draft') throw new PlatformError('conflict', 'Only a draft can be sent for approval.');
    this.ready(await this.report(current.definition));
    const rec = await this.d.workflows.update(id, { status: 'in_review' });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.publish.request', subjectType: 'workflow', subjectId: id });
    return this.present(rec);
  }

  async approve(actor: ActorRef, id: string): Promise<WorkflowView> {
    const current = await this.require(id);
    if (current.status !== 'in_review') throw new PlatformError('conflict', 'Only a workflow that is waiting for approval can be published.');
    const issues = await this.report(current.definition);
    this.ready(issues);
    const versions = this.versions();
    const version = (await versions.list(id)).length + 1;
    await versions.insert({
      id: randomUUID(), workflowId: id, version, contentHash: contentHash(current.definition), definition: current.definition, approvedBy: actor.id,
    });
    const rec = await this.d.workflows.update(id, { status: 'published' });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.publish.approve', subjectType: 'workflow', subjectId: id, detail: { version } });
    void issues;
    return this.present(rec);
  }

  async duplicate(actor: ActorRef, id: string): Promise<WorkflowView> {
    const current = await this.require(id);
    const created = await this.create(actor, { name: `${current.name} copy`, type: current.type, description: current.description });
    const definition = structuredClone(current.definition);
    const meta = definition.metadata;
    if (meta && typeof meta === 'object') {
      const m = meta as Record<string, unknown>;
      m.key = created.key;
      m.name = created.name;
    }
    await this.d.workflows.update(created.id, { definition });
    return this.get(created.id, true);
  }

  async disable(actor: ActorRef, id: string): Promise<WorkflowView> {
    await this.require(id);
    const rec = await this.d.workflows.update(id, { enabled: false, status: 'disabled' });
    await this.d.audit.append({ actorId: actor.id, action: 'workflow.disable', subjectType: 'workflow', subjectId: id });
    return this.present(rec);
  }

  /**
   * Soft-deletes a workflow the user added.
   * Drafts, in-review, and disabled rows delete freely.
   * A published workflow deletes when nothing is queued/running/paused, or when `force` confirms over active runs.
   */
  async remove(actor: ActorRef, id: string, opts: { force?: boolean } = {}): Promise<void> {
    const rec = await this.require(id);
    if (rec.status === 'published') {
      const active = this.d.executions
        ? (await this.d.executions.listForWorkflow(id)).filter((r) => r.status === 'queued' || r.status === 'running' || r.status === 'paused')
        : [];
      if (active.length > 0 && !opts.force) {
        throw new PlatformError(
          'conflict',
          `${active.length} run${active.length === 1 ? ' is' : 's are'} still active on this published workflow. Cancel ${active.length === 1 ? 'it' : 'them'} first, or confirm delete anyway.`,
        );
      }
    }
    await this.d.workflows.softDelete(id);
    await this.d.audit.append({
      actorId: actor.id,
      action: 'workflow.delete',
      subjectType: 'workflow',
      subjectId: id,
      detail: { key: rec.key, status: rec.status, force: !!opts.force },
    });
  }

  async start(actor: ActorRef, id: string, params: Record<string, unknown>): Promise<ExecutionView> {
    const current = await this.require(id);
    if (current.status !== 'published' || !current.enabled) throw new PlatformError('conflict', 'Only a published workflow can be started.');
    const version = await this.versions().latest(id);
    if (!version) throw new PlatformError('conflict', 'This workflow has no published version.');
    this.ready(await this.report(version.definition));
    const def = asDef(version.definition);
    for (const p of def.spec?.parameters ?? []) {
      const missing = params[p.name] === undefined || params[p.name] === '';
      if (current.type === 'requirement-validation' && p.name === 'environment') continue;
      if (p.required && (p.pinned === undefined || p.pinned === null) && missing) throw new PlatformError('validation', `${p.name} is required to start this workflow.`);
    }
    const run = await this.executions().insert({ id: randomUUID(), workflowId: id, versionId: version.id, definition: version.definition, params });
    await this.d.audit.append({ actorId: actor.id, action: 'execution.start', subjectType: 'workflow_execution', subjectId: run.id, detail: { workflowId: id, versionId: version.id } });
    return runOf(run, current.name);
  }

  async runs(workflowId: string): Promise<ExecutionView[]> {
    const workflow = await this.require(workflowId);
    return (await this.executions().listForWorkflow(workflowId)).map((r) => runOf(r, workflow.name));
  }

  async history(): Promise<ExecutionView[]> {
    const runs = await this.executions().listRecent(100);
    const names = new Map((await this.d.workflows.list()).map((w) => [w.id, w.name]));
    return runs.map((r) => runOf(r, names.get(r.workflowId) ?? 'Removed workflow'));
  }

  async run(id: string): Promise<ExecutionView> {
    const row = await this.executions().get(id);
    if (!row) throw new PlatformError('not-found', 'Run not found');
    return runOf(row, await this.workflowName(row.workflowId));
  }

  async events(id: string): Promise<ExecutionEvent[]> {
    if (!(await this.executions().get(id))) throw new PlatformError('not-found', 'Run not found');
    return this.executions().events(id);
  }

  async control(actor: ActorRef, id: string, command: 'pause' | 'resume' | 'cancel'): Promise<ExecutionView> {
    const repo = this.executions();
    const current = await repo.get(id);
    if (!current) throw new PlatformError('not-found', 'Run not found');
    const next = commandOf(current, command);
    if (next.status === current.status && next.control === current.control) return runOf(current, await this.workflowName(current.workflowId));
    // Keep the worker lease when signalling cancel on a running execution so the owner
    // (or the next claim after expiry) can stop runners before clearing leaseOwner.
    const keepLease = next.status === 'running' && (next.control === 'pause' || next.control === 'cancel');
    const saved = await repo.apply(id, keepLease
      ? { status: next.status, control: next.control }
      : { status: next.status, control: next.control, leaseOwner: null, leaseUntil: null });
    await this.d.audit.append({ actorId: actor.id, action: `execution.${command}`, subjectType: 'workflow_execution', subjectId: id });
    return runOf(saved, await this.workflowName(saved.workflowId));
  }

  private async workflowName(id: string): Promise<string> {
    return (await this.d.workflows.get(id))?.name ?? 'Removed workflow';
  }

  private async present(row: WorkflowRecord): Promise<WorkflowView> {
    const latest = this.d.versions ? await this.d.versions.latest(row.id) : undefined;
    return viewOf(row, latest?.version ?? null);
  }

  private async report(definition: Record<string, unknown>): Promise<ValidationIssue[]> {
    const def = asDef(definition);
    const pinned = def.spec?.environment?.pinnedEnvironmentId ?? null;
    const environment = pinned ? (this.d.environment ? await this.d.environment(pinned) : null) : undefined;
    return validateWorkflow(def, { instances: await this.instances(def), ...(environment !== undefined ? { environment } : {}) });
  }

  private async instances(def: WfDef): Promise<BoundInstance[]> {
    const out: BoundInstance[] = [];
    for (const c of def.spec?.connectors ?? []) {
      const id = c.binding?.connectorInstanceId;
      if (!id) continue;
      if (id === 'managed') {
        const ok = c.category === 'test-runner';
        out.push({ role: c.role, category: c.category, enabled: ok, health: ok ? 'healthy' : 'unhealthy', accessMode: 'read_only', capabilities: ok ? [...c.requiredCapabilities, ...(c.optionalCapabilities ?? [])] : [] });
        continue;
      }
      const row = this.d.connectors ? await this.d.connectors.get(id) : undefined;
      if (!row) {
        out.push({ role: c.role, category: c.category, enabled: false, health: 'unhealthy', accessMode: 'read_only', capabilities: [] });
        continue;
      }
      const states = await this.d.connectors!.capabilityStates(id);
      const health = row.status === 'connected' ? 'healthy' : row.status === 'degraded' ? 'degraded' : 'unhealthy';
      const capabilities = states.filter((s) => s.granted).map((s) => s.capability);
      if (row.category === 'test-management' && capabilities.includes('tm.testcase.list') && !capabilities.includes('tm.testcase.read')) capabilities.push('tm.testcase.read');
      // Match CEM: a writable Squash instance can create executions, PATCH status, and upload attachments.
      if (row.category === 'test-management' && row.accessMode === 'read_write') {
        for (const cap of ['tm.testcase.upsert', 'tm.execution.upsert', 'tm.execution.status.update', 'tm.attachment.upload'] as const) {
          if (!capabilities.includes(cap)) capabilities.push(cap);
        }
      }
      out.push({ role: c.role, category: row.category, enabled: row.enabled, health, accessMode: row.accessMode, capabilities });
    }
    return out;
  }

  private ready(issues: ValidationIssue[]) {
    const errors = errorsOf(issues);
    if (errors.length === 0) return;
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const e of errors) {
      const line = `${e.message} ${e.fixHint}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length === 3) break;
    }
    throw new PlatformError('validation', lines.join(' '));
  }

  private versions() {
    if (!this.d.versions) throw new PlatformError('unsupported', 'Workflow versions are not available.');
    return this.d.versions;
  }

  private executions() {
    if (!this.d.executions) throw new PlatformError('unsupported', 'Workflow runs are not available.');
    return this.d.executions;
  }

  private async editable(id: string) {
    const current = await this.require(id);
    if (current.status !== 'draft') throw new PlatformError('conflict', 'Only a draft can be edited. Published versions stay as they were.');
    return current;
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

function commandOf(run: ExecutionRecord, command: 'pause' | 'resume' | 'cancel'): { status: ExecutionStatus; control: ExecutionRecord['control'] } {
  if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return { status: run.status, control: null };
  if (command === 'cancel') {
    // Queued / paused: finalize immediately and clear the lease.
    // Running: set control so the worker stops runners, then clears the lease on the cancel tick.
    if (run.status === 'queued' || run.status === 'paused') return { status: 'cancelled', control: null };
    return { status: 'running', control: 'cancel' };
  }
  if (command === 'resume') return run.status === 'paused' ? { status: 'queued', control: null } : { status: run.status, control: run.control };
  if (run.status === 'paused') return { status: 'paused', control: null };
  if (run.status === 'queued') return { status: 'paused', control: null };
  return { status: 'running', control: 'pause' };
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
      policy: { capabilityDeny: type === 'regression-testing' ? ['tm.testcase.upsert', 'scm.*', 'browser.*', 'agent.*'] : ['scm.write.*'] },
      steps: [],
    },
  };
}
