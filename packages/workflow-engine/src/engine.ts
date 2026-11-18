export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface ClaimedRun {
  id: string;
  status: RunStatus;
  stepIndex: number;
  phase: 'pending' | 'effect';
  control: 'pause' | 'cancel' | null;
  definition: unknown;
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
}

export interface TickOptions {
  owner: string;
  now: Date;
  leaseMs?: number;
  /** Commit the side effect, then die before the step is marked complete. */
  crashAfterEffect?: boolean;
}

const enabledSteps = (definition: unknown): { id: string }[] => {
  const steps = (definition as { spec?: { steps?: { id?: string; enabled?: boolean }[] } } | null)?.spec?.steps ?? [];
  return steps.filter((s) => s && s.enabled !== false && s.id).map((s) => ({ id: String(s.id) }));
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
  const next = run.stepIndex + 1;
  const done = next >= steps.length;
  await store.save(run.id, { stepIndex: next, phase: 'pending', status: done ? 'succeeded' : 'running', ...(done ? clear : {}) });
  await store.append(run.id, 'step.completed', { stepId: step.id, repeated: effect === 'exists' });
  if (done) await store.append(run.id, 'succeeded', {});
  return 'busy';
}
