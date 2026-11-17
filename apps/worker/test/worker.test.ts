import { describe, expect, it, vi } from 'vitest';
import { WorkerLoop, buildWorkerApp, type TickResult } from '../src';

const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('WorkerLoop', () => {
  it('asks again at once after busy ticks and waits after idle ones', async () => {
    const results: TickResult[] = ['busy', 'busy', 'idle'];
    const tick = vi.fn(async () => results.shift() ?? 'idle');
    const loop = new WorkerLoop({ tick, idleDelayMs: 40, busyDelayMs: 0 });
    loop.start();
    await until(() => tick.mock.calls.length >= 3);
    const callsAfterIdle = tick.mock.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(tick.mock.calls.length).toBe(callsAfterIdle);
    await loop.stop();
    expect(loop.snapshot()).toMatchObject({ state: 'stopped', errors: 0 });
  });

  it('survives failing ticks, backs off, recovers, and reports each error', async () => {
    const errors: unknown[] = [];
    let n = 0;
    const loop = new WorkerLoop({
      tick: async () => {
        n += 1;
        if (n <= 3) throw new Error('db down');
        return 'idle';
      },
      idleDelayMs: 1,
      maxBackoffMs: 4,
      onError: (e) => errors.push(e),
    });
    loop.start();
    await until(() => loop.snapshot().ticks >= 1);
    expect(loop.snapshot()).toMatchObject({ errors: 3, consecutiveErrors: 0 });
    expect(errors).toHaveLength(3);
    await loop.stop();
  });

  it('keeps running when the error hook itself throws', async () => {
    let n = 0;
    const loop = new WorkerLoop({ tick: async () => { n += 1; throw new Error('x'); }, idleDelayMs: 1, maxBackoffMs: 2, onError: () => { throw new Error('hook'); } });
    loop.start();
    await until(() => n >= 3);
    await loop.stop();
  });

  it('stop() waits for the tick in flight, and aborts it only after the grace period', async () => {
    let aborted = false;
    let release!: () => void;
    const loop = new WorkerLoop({
      tick: (signal) => new Promise<TickResult>((resolve) => {
        release = () => resolve('idle');
        signal.addEventListener('abort', () => { aborted = true; resolve('idle'); });
      }),
      graceMs: 30,
    });
    loop.start();
    await until(() => release !== undefined);
    const stopping = loop.stop();
    expect(loop.snapshot().state).toBe('stopping');
    await new Promise((r) => setTimeout(r, 10));
    expect(aborted).toBe(false);
    await stopping;
    expect(aborted).toBe(true);
    expect(loop.snapshot().state).toBe('stopped');
  });

  it('stops promptly while sleeping between ticks', async () => {
    const loop = new WorkerLoop({ tick: async () => 'idle', idleDelayMs: 60_000 });
    loop.start();
    await until(() => loop.snapshot().ticks >= 1);
    const t = Date.now();
    await loop.stop();
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('cannot be started twice, and stopping a loop that never started is safe', async () => {
    const loop = new WorkerLoop({ tick: async () => 'idle', idleDelayMs: 1 });
    loop.start();
    expect(() => loop.start()).toThrow(/cannot start/);
    await loop.stop();
    await loop.stop();
    const never = new WorkerLoop({ tick: async () => 'idle' });
    await never.stop();
    expect(never.snapshot().state).toBe('stopped');
  });

  it('is alive only while running and recently active', async () => {
    let t = 1_000;
    const loop = new WorkerLoop({ tick: async () => 'idle', idleDelayMs: 60_000, now: () => t });
    expect(loop.isAlive(10)).toBe(false);
    loop.start();
    await until(() => loop.snapshot().ticks >= 1);
    expect(loop.isAlive(10)).toBe(true);
    t += 100;
    expect(loop.isAlive(10)).toBe(false);
    await loop.stop();
    expect(loop.isAlive(1_000_000)).toBe(false);
  });
});

describe('worker health endpoints', () => {
  it('reports healthy while the loop runs, unhealthy after it stops', async () => {
    const loop = new WorkerLoop({ tick: async () => 'idle', idleDelayMs: 5 });
    const app = buildWorkerApp({ loop, profile: 'standard' });
    expect((await app.inject('/healthz')).statusCode).toBe(503);
    loop.start();
    await until(() => loop.snapshot().ticks >= 1);
    const ok = await app.inject('/healthz');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ok', profile: 'standard', loop: 'running' });
    await loop.stop();
    expect((await app.inject('/healthz')).statusCode).toBe(503);
  });

  it('readiness lists failing dependencies and exposes nothing else', async () => {
    const loop = new WorkerLoop({ tick: async () => 'idle' });
    const app = buildWorkerApp({ loop, profile: 'airgapped', readiness: { database: async () => false, queue: async () => true } });
    const r = await app.inject('/readyz');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'degraded', failing: ['database'] });
    expect((await app.inject('/api/v1/anything')).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/healthz' })).statusCode).toBe(404);
  });
});
