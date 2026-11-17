import { PlatformError, assertValidRunnerSpec, type Clock, type RunnerHandle, type RunnerLauncher, type RunnerSpec, type RunnerState, type RunnerStatus } from '@qa/domain';

interface Rec {
  spec: RunnerSpec;
  handle: RunnerHandle;
  state: RunnerState;
  exitCode?: number;
  finishedAt?: Date;
  reason?: string;
}

/** In-memory launcher with the same contract as real adapters: validation, idempotent launch, label listing. */
export class FakeRunnerLauncher implements RunnerLauncher {
  private readonly byId = new Map<string, Rec>();
  private readonly byRun = new Map<string, string>();
  launches = 0;

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  async launch(spec: RunnerSpec, opts?: { signal?: AbortSignal }): Promise<RunnerHandle> {
    assertValidRunnerSpec(spec);
    if (opts?.signal?.aborted) throw new PlatformError('cancelled', 'launch cancelled');
    const existing = this.byRun.get(spec.runId);
    if (existing) return this.byId.get(existing)!.handle;
    this.launches += 1;
    const id = `runner-${this.launches}`;
    const handle: RunnerHandle = { id, runId: spec.runId, startedAt: this.clock.now() };
    this.byId.set(id, { spec, handle, state: 'running' });
    this.byRun.set(spec.runId, id);
    return handle;
  }

  async status(runnerId: string): Promise<RunnerStatus> {
    return this.toStatus(this.get(runnerId));
  }

  async stop(runnerId: string, reason: string): Promise<void> {
    const r = this.get(runnerId);
    if (r.state === 'running' || r.state === 'starting') Object.assign(r, { state: 'stopped', finishedAt: this.clock.now(), reason });
  }

  async list(labels: Record<string, string>): Promise<RunnerStatus[]> {
    return [...this.byId.values()].filter((r) => Object.entries(labels).every(([k, v]) => r.spec.labels?.[k] === v)).map((r) => this.toStatus(r));
  }

  /** Test control: the runner finished by itself. */
  finish(runnerId: string, exitCode: number): void {
    Object.assign(this.get(runnerId), { state: exitCode === 0 ? 'exited' : 'failed', exitCode, finishedAt: this.clock.now() });
  }

  specOf(runnerId: string): RunnerSpec {
    return this.get(runnerId).spec;
  }

  private get(id: string): Rec {
    const r = this.byId.get(id);
    if (!r) throw new PlatformError('not-found', `runner ${id} not found`);
    return r;
  }

  private toStatus(r: Rec): RunnerStatus {
    return { id: r.handle.id, runId: r.handle.runId, state: r.state, exitCode: r.exitCode, finishedAt: r.finishedAt, reason: r.reason };
  }
}
