import { counter } from '@qa/telemetry';

const TICKS = counter('qa.worker.ticks', 'Worker scheduling ticks by result');

export type TickResult = 'busy' | 'idle';
export type LoopState = 'created' | 'running' | 'stopping' | 'stopped';

export interface LoopSnapshot {
  state: LoopState;
  ticks: number;
  errors: number;
  consecutiveErrors: number;
  lastActivityAt?: Date;
  lastErrorAt?: Date;
}

export interface WorkerLoopOptions {
  /** One unit of scheduling work. Returns 'busy' when it found work, so the loop asks again at once. */
  tick(signal: AbortSignal): Promise<TickResult>;
  idleDelayMs?: number;
  busyDelayMs?: number;
  maxBackoffMs?: number;
  /** After stop(), how long an in-flight tick may keep running before its signal is aborted. */
  graceMs?: number;
  onError?(e: unknown): void;
  now?(): number;
  random?(): number;
}

/**
 * The worker's heartbeat: ask for work, run it, back off when things fail, stop cleanly.
 * The caller supplies `tick`. Nothing here knows about workflows.
 */
export class WorkerLoop {
  private state: LoopState = 'created';
  private ticks = 0;
  private errors = 0;
  private consecutiveErrors = 0;
  private lastActivityAt?: number;
  private lastErrorAt?: number;
  private done?: Promise<void>;
  private readonly stopRequested = new AbortController();
  private readonly hardAbort = new AbortController();

  constructor(private readonly o: WorkerLoopOptions) {}

  start(): void {
    if (this.state !== 'created') throw new Error(`cannot start a loop that is ${this.state}`);
    this.state = 'running';
    this.touch();
    this.done = this.run();
  }

  /** Stops asking for work and waits for the in-flight tick, aborting it after the grace period. */
  async stop(): Promise<void> {
    if (this.state === 'created') {
      this.state = 'stopped';
      return;
    }
    if (this.state === 'running') {
      this.state = 'stopping';
      this.stopRequested.abort();
      const timer = setTimeout(() => this.hardAbort.abort(), this.o.graceMs ?? 30_000);
      timer.unref?.();
      try {
        await this.done;
      } finally {
        clearTimeout(timer);
      }
    } else {
      await this.done;
    }
  }

  snapshot(): LoopSnapshot {
    return {
      state: this.state,
      ticks: this.ticks,
      errors: this.errors,
      consecutiveErrors: this.consecutiveErrors,
      lastActivityAt: this.lastActivityAt === undefined ? undefined : new Date(this.lastActivityAt),
      lastErrorAt: this.lastErrorAt === undefined ? undefined : new Date(this.lastErrorAt),
    };
  }

  /** Alive means running and heard from recently. A stuck tick turns this false so the orchestrator restarts the container. */
  isAlive(stallAfterMs: number): boolean {
    if (this.state !== 'running') return false;
    return this.now() - (this.lastActivityAt ?? 0) <= stallAfterMs;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private touch(): void {
    this.lastActivityAt = this.now();
  }

  private async run(): Promise<void> {
    while (!this.stopRequested.signal.aborted) {
      let delay: number;
      try {
        const r = await this.o.tick(this.hardAbort.signal);
        this.ticks += 1;
        TICKS.add(1, { result: r });
        this.consecutiveErrors = 0;
        delay = r === 'busy' ? (this.o.busyDelayMs ?? 0) : (this.o.idleDelayMs ?? 1_000);
      } catch (e) {
        this.errors += 1;
        TICKS.add(1, { result: 'error' });
        this.consecutiveErrors += 1;
        this.lastErrorAt = this.now();
        try {
          this.o.onError?.(e);
        } catch {
          // a failing error hook must not stop the loop
        }
        const base = this.o.idleDelayMs ?? 1_000;
        const ceiling = Math.min(this.o.maxBackoffMs ?? 30_000, base * 2 ** Math.min(this.consecutiveErrors, 10));
        delay = Math.floor(ceiling / 2 + (this.o.random ?? Math.random)() * (ceiling / 2));
      }
      this.touch();
      if (delay > 0) await this.sleep(delay);
    }
    this.state = 'stopped';
    this.touch();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopRequested.signal;
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
