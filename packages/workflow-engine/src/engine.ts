export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface ClaimedRun {
  id: string;
  status: RunStatus;
  stepIndex: number;
  phase: 'pending' | 'effect';
  control: 'pause' | 'cancel' | null;
  definition: unknown;
  params?: Record<string, unknown>;
}

export interface RunPatch {
  status?: RunStatus;
  stepIndex?: number;
  phase?: 'pending' | 'effect';
  control?: 'pause' | 'cancel' | null;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
}

/** What the worker needs from Postgres. The API never calls this. */
export interface EngineStore {
  claim(owner: string, now: Date, leaseMs: number): Promise<ClaimedRun | undefined>;
  recordEffect(id: string, stepId: string, key: string): Promise<'new' | 'exists'>;
  save(id: string, patch: RunPatch): Promise<void>;
  append(id: string, kind: string, payload: Record<string, unknown>): Promise<void>;
  /** Completed step outputs, keyed later by step id. Omitted by stores that only record the effect. */
  stepsDone?(id: string): Promise<{ stepId: string; outputs: Record<string, unknown> }[]>;
}

export interface TickOptions {
  owner: string;
  now: Date;
  leaseMs?: number;
  /** Commit the side effect, then die before the step is marked complete. */
  crashAfterEffect?: boolean;
  /** Runs after a new effect is recorded. A repeated effect skips this so the work happens once. */
  perform?(step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> }): Promise<{ summary: string; outputs?: Record<string, unknown> }>;
}

/** Requirement validation ends when the cases are stored. Execution is a later action on the work item. */
const AFTER_CASES = new Set(['rv.execute-tests', 'rv.sync-results', 'rv.qa-report']);

const enabledSteps = (definition: unknown): { id: string; type: string }[] => {
  const steps = (definition as { spec?: { steps?: { id?: string; type?: string; enabled?: boolean }[] } } | null)?.spec?.steps ?? [];
  return steps.filter((s) => s && s.enabled !== false && s.id && !AFTER_CASES.has(String(s.type ?? s.id))).map((s) => ({ id: String(s.id), type: String(s.type ?? s.id) }));
};

/**
 * One unit of engine work. A step's side effect is recorded before the step is completed,
 * so a worker that dies in between resumes the same effect instead of repeating it.
 */
export async function tick(store: EngineStore, opts: TickOptions): Promise<'busy' | 'idle'> {
  const run = await store.claim(opts.owner, opts.now, opts.leaseMs ?? 30_000);
  if (!run) return 'idle';
  const clear = { leaseOwner: null, leaseUntil: null };
  if (run.control === 'cancel') {
    await store.save(run.id, { status: 'cancelled', control: null, ...clear });
    await store.append(run.id, 'cancelled', {});
    return 'busy';
  }
  if (run.control === 'pause') {
    await store.save(run.id, { status: 'paused', control: null, ...clear });
    await store.append(run.id, 'paused', {});
    return 'busy';
  }
  const steps = enabledSteps(run.definition);
  const step = steps[run.stepIndex];
  if (!step) {
    await store.save(run.id, { status: 'succeeded', ...clear });
    await store.append(run.id, 'succeeded', {});
    return 'busy';
  }
  const effect = await store.recordEffect(run.id, step.id, step.id);
  if (opts.crashAfterEffect && effect === 'new') throw new Error('worker killed');
  let summary = '';
  let outputs: Record<string, unknown> = {};
  if (opts.perform && effect === 'new') {
    const doneSteps = store.stepsDone ? await store.stepsDone(run.id) : [];
    const prior = Object.fromEntries(doneSteps.map((item) => [item.stepId, item.outputs]));
    try {
      const result = await opts.perform({ id: step.id, type: step.type, runId: run.id, params: run.params ?? {}, prior });
      summary = result.summary;
      outputs = result.outputs ?? {};
    } catch (e) {
      const message = e instanceof Error ? e.message : 'The step failed.';
      await store.save(run.id, { status: 'failed', ...clear });
      // summary mirrors message so Executions / Workflow Run UIs that only read summary still show the error.
      await store.append(run.id, 'step.failed', { stepId: step.id, stepType: step.type, message, summary: message });
      return 'busy';
    }
  }
  const next = run.stepIndex + 1;
  const done = next >= steps.length;
  await store.save(run.id, { stepIndex: next, phase: 'pending', status: done ? 'succeeded' : 'running', ...(done ? clear : {}) });
  await store.append(run.id, 'step.completed', { stepId: step.id, repeated: effect === 'exists', summary, outputs });
  if (done) await store.append(run.id, 'succeeded', {});
  return 'busy';
}
