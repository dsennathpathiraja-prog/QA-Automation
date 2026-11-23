import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { ExecutionPolicy } from '@qa/connector-sdk';
import type { ExecutionEvent, ExecutionRecord, ExecutionRepository, ExecutionStatus, NewExecution } from '@qa/application';
import type { Db } from './db';
import { DEFAULT_PROJECT_ID } from './project-repository';
import { connectorInstance, egressAllowlist, environment, workflow, workflowEvent, workflowExecution } from './schema';

const toRecord = (r: typeof workflowExecution.$inferSelect): ExecutionRecord => ({
  id: r.id,
  projectId: r.projectId,
  workflowId: r.workflowId,
  versionId: r.versionId,
  status: r.status as ExecutionStatus,
  stepIndex: r.stepIndex,
  control: (r.control as ExecutionRecord['control']) ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: Db) {}

  async insert(n: NewExecution) {
    const [wf] = await this.db.select({ projectId: workflow.projectId }).from(workflow).where(eq(workflow.id, n.workflowId)).limit(1);
    const projectId = n.projectId ?? wf?.projectId ?? DEFAULT_PROJECT_ID;
    const [row] = await this.db
      .insert(workflowExecution)
      .values({ id: n.id, projectId, workflowId: n.workflowId, versionId: n.versionId, definition: n.definition, params: n.params, status: 'queued' })
      .returning();
    await this.append(n.id, 'started', {});
    return toRecord(row!);
  }

  async get(id: string) {
    const [row] = await this.db.select().from(workflowExecution).where(eq(workflowExecution.id, id)).limit(1);
    return row && toRecord(row);
  }

  async listForWorkflow(workflowId: string) {
    const rows = await this.db.select().from(workflowExecution).where(eq(workflowExecution.workflowId, workflowId)).orderBy(desc(workflowExecution.createdAt));
    return rows.map(toRecord);
  }

  async listRecent(limit: number, filter?: { projectId?: string }) {
    const rows = filter?.projectId
      ? await this.db.select().from(workflowExecution).where(eq(workflowExecution.projectId, filter.projectId)).orderBy(desc(workflowExecution.createdAt)).limit(limit)
      : await this.db.select().from(workflowExecution).orderBy(desc(workflowExecution.createdAt)).limit(limit);
    return rows.map(toRecord);
  }

  async events(id: string): Promise<ExecutionEvent[]> {
    const rows = await this.db.select().from(workflowEvent).where(eq(workflowEvent.executionId, id)).orderBy(workflowEvent.seq);
    return rows.map((r) => ({ seq: r.seq, kind: r.kind, payload: r.payload, at: r.at.toISOString() }));
  }

  async apply(id: string, patch: { status?: ExecutionStatus; control?: ExecutionRecord['control']; leaseOwner?: string | null; leaseUntil?: Date | null }) {
    await this.save(id, patch);
    const row = await this.get(id);
    if (!row) throw new PlatformError('not-found', 'Run not found');
    return row;
  }

  async claim(owner: string, now: Date, leaseMs: number) {
    const until = new Date(now.getTime() + leaseMs);
    const result = await this.db.execute(sql`
      UPDATE workflow_execution AS e
      SET lease_owner = ${owner}, lease_until = ${until}, status = 'running', updated_at = ${now}
      FROM (
        SELECT id FROM workflow_execution
        WHERE status IN ('queued', 'running')
          AND (lease_until IS NULL OR lease_until < ${now} OR lease_owner = ${owner})
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ) AS picked
      WHERE e.id = picked.id
        RETURNING e.id, e.status, e.step_index, e.phase, e.control, e.definition, e.params
    `);
    const row = rowsOf(result)[0];
    if (!row) return undefined;
    return {
      id: String(row.id),
      status: 'running' as const,
      stepIndex: Number(row.step_index),
      phase: (row.phase === 'effect' ? 'effect' : 'pending') as 'pending' | 'effect',
      control: (row.control === 'pause' || row.control === 'cancel' ? row.control : null) as 'pause' | 'cancel' | null,
      definition: row.definition,
      params: row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {},
    };
  }

  async recordEffect(id: string, stepId: string, key: string): Promise<'new' | 'exists'> {
    const result = await this.db.execute(sql`
      INSERT INTO workflow_effect (execution_id, step_id, effect_key)
      VALUES (${id}, ${stepId}, ${key})
      ON CONFLICT DO NOTHING
      RETURNING effect_key
    `);
    return rowsOf(result).length > 0 ? 'new' : 'exists';
  }

  async save(id: string, patch: { status?: ExecutionStatus; stepIndex?: number; phase?: 'pending' | 'effect'; control?: ExecutionRecord['control']; leaseOwner?: string | null; leaseUntil?: Date | null }) {
    const set: Partial<typeof workflowExecution.$inferInsert> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.stepIndex !== undefined) set.stepIndex = patch.stepIndex;
    if (patch.phase !== undefined) set.phase = patch.phase;
    if (patch.control !== undefined) set.control = patch.control;
    if (patch.leaseOwner !== undefined) set.leaseOwner = patch.leaseOwner;
    if (patch.leaseUntil !== undefined) set.leaseUntil = patch.leaseUntil;
    const [row] = await this.db.update(workflowExecution).set(set).where(eq(workflowExecution.id, id)).returning();
    if (!row) throw new PlatformError('not-found', 'Run not found');
  }

  async append(id: string, kind: string, payload: Record<string, unknown>) {
    await this.db.insert(workflowEvent).values({ executionId: id, kind, payload });
  }

  async stepsDone(id: string) {
    const rows = await this.events(id);
    return rows.filter((row) => row.kind === 'step.completed').map((row) => ({
      stepId: typeof row.payload.stepId === 'string' ? row.payload.stepId : '',
      outputs: row.payload.outputs && typeof row.payload.outputs === 'object' ? row.payload.outputs as Record<string, unknown> : {},
    }));
  }
}

/** The connector roles bound on the run, so a step can store a generated case in Squash. */
export class PgRunPolicyStore {
  constructor(private readonly db: Db) {}

  /**
   * Builds policy fresh on every invoke (no worker-side cache of hosts/origins).
   * Browser allowlist comes from the selected environment URL, approved
   * *application* hosts, and the bound Playwright connector addresses.
   */
  async get(executionId: string): Promise<ExecutionPolicy | undefined> {
    const [row] = await this.db
      .select({ definition: workflowExecution.definition, params: workflowExecution.params })
      .from(workflowExecution)
      .where(eq(workflowExecution.id, executionId))
      .limit(1);
    if (!row) return undefined;
    const spec = (row.definition as { spec?: { connectors?: { role?: string; binding?: { connectorInstanceId?: string | null } }[]; policy?: { capabilityDeny?: string[] } } } | null)?.spec;
    const boundRoles: Record<string, string> = {};
    for (const connector of spec?.connectors ?? []) {
      const id = connector.binding?.connectorInstanceId;
      if (connector.role && id) boundRoles[connector.role] = id;
    }

    const allowed = new Set<string>();
    const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {};
    const envRef = typeof params.environment === 'string' ? params.environment.trim() : '';
    let environmentKind: ExecutionPolicy['environmentKind'];

    if (envRef) {
      const env = await this.resolveEnvironment(envRef);
      if (env) {
        environmentKind = env.kind as ExecutionPolicy['environmentKind'];
        this.addApplicationUrl(allowed, env.applicationUrl);
      }
    }

    // Always re-read application-purpose hosts (category), never a stale worker snapshot.
    const appHosts = await this.db.select({ hostPattern: egressAllowlist.hostPattern }).from(egressAllowlist).where(eq(egressAllowlist.purpose, 'application'));
    for (const h of appHosts) {
      if (h.hostPattern) allowed.add(h.hostPattern);
    }

    const browserId = boundRoles.browserAutomation;
    if (browserId) {
      const [inst] = await this.db.select({ config: connectorInstance.config }).from(connectorInstance).where(eq(connectorInstance.id, browserId)).limit(1);
      const raw = inst?.config && typeof inst.config === 'object' ? (inst.config as Record<string, unknown>).allowedOrigins : undefined;
      if (typeof raw === 'string') {
        for (const part of raw.split(',')) {
          const entry = part.trim();
          if (entry) allowed.add(entry);
        }
      }
    }

    return {
      capabilityDeny: spec?.policy?.capabilityDeny ?? ['scm.write.*'],
      boundRoles,
      agentGrants: {},
      environmentKind,
      allowedOrigins: [...allowed],
    };
  }

  private async resolveEnvironment(ref: string): Promise<{ kind: string; applicationUrl: string } | undefined> {
    const live = isNull(environment.deletedAt);
    if (UUID.test(ref)) {
      const [byId] = await this.db.select({ kind: environment.kind, applicationUrl: environment.applicationUrl }).from(environment).where(and(eq(environment.id, ref), live)).limit(1);
      if (byId) return byId;
    }
    const [byName] = await this.db.select({ kind: environment.kind, applicationUrl: environment.applicationUrl }).from(environment).where(and(eq(environment.name, ref), live)).limit(1);
    return byName;
  }

  private addApplicationUrl(allowed: Set<string>, applicationUrl: string) {
    try {
      const url = new URL(applicationUrl);
      allowed.add(url.origin);
      allowed.add(url.hostname.toLowerCase());
    } catch {
      /* ignore a bad stored URL; host list still applies */
    }
  }
}
