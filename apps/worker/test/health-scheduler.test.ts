import { describe, expect, it } from 'vitest';
import { InMemoryConnectorRepository, InMemoryTestQueue } from '@qa/testing';
import { ConnectorHealthScheduler } from '../src';

const at = new Date('2026-11-18T10:00:00Z');

async function connector(repo: InMemoryConnectorRepository, over: { enabled?: boolean; status?: 'connected' | 'draft'; tested?: Date } = {}) {
  const rec = await repo.insert({ id: crypto.randomUUID(), projectId: '01900000-0000-7000-8000-000000000001', providerKey: 'github', category: 'source-repo', name: `Repo ${repo.rows.size}`, config: {}, accessMode: 'read_only' });
  await repo.update(rec.id, { enabled: over.enabled ?? false, status: over.status ?? 'draft', ...(over.tested ? { lastTestedAt: over.tested } : {}) });
  return rec.id;
}

describe('connector health schedule', () => {
  it('queues a test for an enabled connector that is due, and skips one tested recently or already queued', async () => {
    const connectors = new InMemoryConnectorRepository();
    const tests = new InMemoryTestQueue();
    const due = await connector(connectors, { enabled: true, status: 'connected', tested: new Date(at.getTime() - 60 * 60_000) });
    const fresh = await connector(connectors, { enabled: true, status: 'connected', tested: new Date(at.getTime() - 60_000) });
    await connector(connectors, { enabled: false, status: 'connected' });
    const scheduler = new ConnectorHealthScheduler({ connectors, tests, intervalMs: 15 * 60_000, clock: { now: () => at } });
    expect(await scheduler.enqueueDue()).toBe(1);
    expect((await tests.latest(due))?.requestedBy).toBe('system:health');
    expect(await tests.latest(fresh)).toBeUndefined();
    expect(await scheduler.enqueueDue()).toBe(0);
  });

  it('does nothing when the schedule is switched off', async () => {
    const connectors = new InMemoryConnectorRepository();
    const tests = new InMemoryTestQueue();
    await connector(connectors, { enabled: true, status: 'connected' });
    const scheduler = new ConnectorHealthScheduler({ connectors, tests, intervalMs: 0, clock: { now: () => at } });
    expect(await scheduler.enqueueDue()).toBe(0);
  });
});
