import { describe, expect, it } from 'vitest';
import { tick, type ClaimedRun, type EngineStore, type RunPatch } from '../src';

interface Run extends ClaimedRun {
  leaseOwner: string | null;
  leaseUntil: Date | null;
}

class MemoryStore implements EngineStore {
  runs: Run[] = [];
  effects: { id: string; stepId: string }[] = [];
  events: { id: string; kind: string }[] = [];
  claims = 0;
  failClaims = 0;

  add(definition: unknown) {
    this.runs.push({ id: 'run-1', status: 'queued', stepIndex: 0, phase: 'pending', control: null, definition, leaseOwner: null, leaseUntil: null });
  }

  async claim(owner: string, now: Date, leaseMs: number) {
    this.claims += 1;
    if (this.claims <= this.failClaims) throw new Error('connection reset');
    const run = this.runs.find((r) => (r.status === 'queued' || r.status === 'running') && (r.leaseUntil === null || r.leaseUntil < now || r.leaseOwner === owner));
    if (!run) return undefined;
    run.status = 'running';
    run.leaseOwner = owner;
    run.leaseUntil = new Date(now.getTime() + leaseMs);
    return { ...run, definition: run.definition };
  }

  async recordEffect(id: string, stepId: string) {
    if (this.effects.some((e) => e.id === id && e.stepId === stepId)) return 'exists' as const;
    this.effects.push({ id, stepId });
    return 'new' as const;
  }

  async save(id: string, patch: RunPatch) {
    const run = this.runs.find((r) => r.id === id)!;
    if (patch.status) run.status = patch.status;
    if (patch.stepIndex !== undefined) run.stepIndex = patch.stepIndex;
    if (patch.phase) run.phase = patch.phase;
    if (patch.control !== undefined) run.control = patch.control;
    if (patch.leaseOwner !== undefined) run.leaseOwner = patch.leaseOwner;
    if (patch.leaseUntil !== undefined) run.leaseUntil = patch.leaseUntil;
  }

  async append(id: string, kind: string) {
    this.events.push({ id, kind });
  }
}

const definition = { spec: { steps: [{ id: 'a', type: 'demo.noop' }, { id: 'b', type: 'demo.noop', enabled: true }] } };
const at = new Date('2026-11-18T12:00:00Z');

describe('workflow engine chaos', () => {
  it('resumes a killed worker without repeating the side effect', async () => {
    const store = new MemoryStore();
    store.add(definition);
    await expect(tick(store, { owner: 'w1', now: at, crashAfterEffect: true })).rejects.toThrow(/worker killed/);
    expect(store.effects).toEqual([{ id: 'run-1', stepId: 'a' }]);
    const blocked = await tick(store, { owner: 'w2', now: at });
    expect(blocked).toBe('idle');
    expect(await tick(store, { owner: 'w2', now: new Date(at.getTime() + 31_000) })).toBe('busy');
    expect(store.effects).toEqual([{ id: 'run-1', stepId: 'a' }]);
    expect(store.runs[0]?.stepIndex).toBe(1);
    expect(store.events.some((e) => e.kind === 'step.completed')).toBe(true);
  });

  it('stops a requirement-validation run once the cases are stored', async () => {
    const store = new MemoryStore();
    store.add({ spec: { steps: [
      { id: 'publish_testcases', type: 'rv.publish-testcases' },
      { id: 'execute', type: 'rv.execute-tests' },
      { id: 'sync', type: 'rv.sync-results' },
      { id: 'report', type: 'rv.qa-report' },
    ] } });
    expect(await tick(store, { owner: 'w1', now: at })).toBe('busy');
    expect(store.runs[0]?.status).toBe('succeeded');
    expect(store.effects.map((e) => e.stepId)).toEqual(['publish_testcases']);
  });

  it('runs the rest of the demo to success, and a second pass does not add effects', async () => {
    const store = new MemoryStore();
    store.add(definition);
    expect(await tick(store, { owner: 'w1', now: at })).toBe('busy');
    expect(await tick(store, { owner: 'w1', now: new Date(at.getTime() + 1000) })).toBe('busy');
    expect(store.runs[0]?.status).toBe('succeeded');
    expect(store.effects).toHaveLength(2);
    expect(await tick(store, { owner: 'w1', now: new Date(at.getTime() + 2000) })).toBe('idle');
    expect(store.effects).toHaveLength(2);
  });

  it('pauses, resumes, and cancels without a second effect', async () => {
    const store = new MemoryStore();
    store.add(definition);
    store.runs[0]!.control = 'pause';
    expect(await tick(store, { owner: 'w1', now: at })).toBe('busy');
    expect(store.runs[0]?.status).toBe('paused');
    expect(store.effects).toHaveLength(0);
    store.runs[0]!.status = 'queued';
    expect(await tick(store, { owner: 'w1', now: at })).toBe('busy');
    store.runs[0]!.control = 'cancel';
    expect(await tick(store, { owner: 'w1', now: new Date(at.getTime() + 1000) })).toBe('busy');
    expect(store.runs[0]?.status).toBe('cancelled');
    expect(store.effects.map((e) => e.stepId)).toEqual(['a']);
  });

  it('survives a dropped database connection on the next tick', async () => {
    const store = new MemoryStore();
    store.failClaims = 1;
    store.add(definition);
    await expect(tick(store, { owner: 'w1', now: at })).rejects.toThrow(/connection reset/);
    expect(await tick(store, { owner: 'w1', now: at })).toBe('busy');
    expect(store.effects).toHaveLength(1);
  });
});
