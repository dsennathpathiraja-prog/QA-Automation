import { desc, eq, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { ExecutionPolicy } from '@qa/connector-sdk';
import type { ExecutionEvent, ExecutionRecord, ExecutionRepository, ExecutionStatus, NewExecution } from '@qa/application';
import type { Db } from './db';
import { workflowEvent, workflowExecution } from './schema';

const toRecord = (r: typeof workflowExecution.$inferSelect): ExecutionRecord => ({
  id: r.id,
  workflowId: r.workflowId,
  versionId: r.versionId,
  status: r.status as ExecutionStatus,
  stepIndex: r.stepIndex,
  control: (r.control as ExecutionRecord['control']) ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const rowsOf = (result: unknown) => (result as { rows: Record<string, unknown>[] }).rows;

export class PgExecutionRepository implements ExecutionRepository {
  constructor(private readonly db: Db) {}

  async insert(n: NewExecution) {
    const [row] = await this.db.insert(workflowExecution).values({ id: n.id, workflowId: n.workflowId, versionId: n.versionId, definition: n.definition, params: n.params, status: 'queued' }).returning();
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

  async listRecent(limit: number) {
    const rows = await this.db.select().from(workflowExecution).orderBy(desc(workflowExecution.createdAt)).limit(limit);
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

  async get(executionId: string): Promise<ExecutionPolicy | undefined> {
    const [row] = await this.db.select({ definition: workflowExecution.definition }).from(workflowExecution).where(eq(workflowExecution.id, executionId)).limit(1);
    if (!row) return undefined;
    const spec = (row.definition as { spec?: { connectors?: { role?: string; binding?: { connectorInstanceId?: string | null } }[]; policy?: { capabilityDeny?: string[] } } } | null)?.spec;
    const boundRoles: Record<string, string> = {};
    for (const connector of spec?.connectors ?? []) {
      const id = connector.binding?.connectorInstanceId;
      if (connector.role && id) boundRoles[connector.role] = id;
    }
    return { capabilityDeny: spec?.policy?.capabilityDeny ?? ['scm.write.*'], boundRoles, agentGrants: {} };
  }
}
