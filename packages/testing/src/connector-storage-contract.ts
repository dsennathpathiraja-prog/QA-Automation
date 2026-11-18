import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovedHostRepository, ConnectorRepository, NewConnector, TestRequestQueue } from '@qa/application';

export interface ConnectorStorageUnderTest {
  connectors: ConnectorRepository;
  tests: TestRequestQueue;
  hosts: ApprovedHostRepository;
}

const newConnector = (over: Partial<NewConnector> = {}): NewConnector => ({
  id: randomUUID(),
  providerKey: 'squash-tm',
  category: 'test-management',
  name: 'Squash QA',
  config: { baseUrl: 'http://squash.example.local/squash', pageSize: 50 },
  accessMode: 'read_only',
  ...over,
});

/** Behaviour every storage adapter for connector management must show, in memory or on Postgres. */
export function connectorStorageContract(name: string, make: () => Promise<ConnectorStorageUnderTest>) {
  describe(`connector storage contract: ${name}`, () => {
    it('creates a disabled read-only draft and reads it back', async () => {
      const { connectors } = await make();
      const n = newConnector();
      const rec = await connectors.insert(n);
      expect(rec).toMatchObject({ id: n.id, name: 'Squash QA', status: 'draft', enabled: false, accessMode: 'read_only', configVersion: 1, config: n.config });
      expect(await connectors.get(n.id)).toMatchObject({ id: n.id, status: 'draft' });
      expect(await connectors.get(randomUUID())).toBeUndefined();
      expect((await connectors.list()).map((c) => c.id)).toEqual([n.id]);
    });

    it('keeps names unique per provider among live connectors', async () => {
      const { connectors } = await make();
      const a = newConnector();
      await connectors.insert(a);
      await expect(connectors.insert(newConnector())).rejects.toMatchObject({ errorClass: 'conflict' });
      await connectors.insert(newConnector({ providerKey: 'sample-work-items', category: 'work-item' }));
      await connectors.softDelete(a.id);
      expect(await connectors.get(a.id)).toBeUndefined();
      await connectors.insert(newConnector());
      expect(await connectors.list()).toHaveLength(2);
    });

    it('applies partial updates and stores test outcomes', async () => {
      const { connectors } = await make();
      const n = newConnector();
      await connectors.insert(n);
      const when = new Date('2026-11-18T10:00:00Z');
      const updated = await connectors.update(n.id, {
        status: 'connected',
        enabled: true,
        lastSuccessAt: when,
        lastTestedAt: when,
        permissionReport: { granted: ['read'], writePermissionsDetected: [] },
        discoveredInfo: { version: '15.0.4' },
      });
      expect(updated).toMatchObject({ status: 'connected', enabled: true, discoveredInfo: { version: '15.0.4' }, permissionReport: { granted: ['read'] } });
      expect(updated.lastSuccessAt?.toISOString()).toBe(when.toISOString());
      const renamed = await connectors.update(n.id, { name: 'Squash production QA', config: { baseUrl: 'http://other.local/squash' }, configVersion: 2, status: 'draft', enabled: false });
      expect(renamed).toMatchObject({ name: 'Squash production QA', configVersion: 2, status: 'draft', enabled: false, config: { baseUrl: 'http://other.local/squash' } });
      expect(renamed.discoveredInfo).toEqual({ version: '15.0.4' });
      await expect(connectors.update(randomUUID(), { enabled: true })).rejects.toMatchObject({ errorClass: 'not-found' });
    });

    it('replaces capability states as a set and records health', async () => {
      const { connectors } = await make();
      const n = newConnector();
      await connectors.insert(n);
      await connectors.replaceCapabilityStates(n.id, [
        { capability: 'tm.project.list', support: 'supported', granted: true },
        { capability: 'tm.suite.list', support: 'unsupported', reason: 'no endpoint', granted: false },
      ]);
      await connectors.replaceCapabilityStates(n.id, [{ capability: 'tm.project.list', support: 'partial', reason: 'filtered client side', granted: true }]);
      expect(await connectors.capabilityStates(n.id)).toEqual([{ capability: 'tm.project.list', support: 'partial', reason: 'filtered client side', granted: true }]);
      await connectors.recordHealth(n.id, { result: 'ok', latencyMs: 12, detail: { note: 'fine' } });
    });

    it('queues one open test per connector and hands each request to one worker', async () => {
      const { connectors, tests } = await make();
      const a = newConnector();
      const b = newConnector({ name: 'Squash second' });
      await connectors.insert(a);
      await connectors.insert(b);
      const r1 = await tests.enqueue(a.id, 1, 'alice');
      const again = await tests.enqueue(a.id, 1, 'bob');
      expect(again.id).toBe(r1.id);
      const r2 = await tests.enqueue(b.id, 1, 'alice');
      expect(r2.id).not.toBe(r1.id);

      const [c1, c2, c3] = [await tests.claimNext(), await tests.claimNext(), await tests.claimNext()];
      expect([c1?.id, c2?.id]).toEqual([r1.id, r2.id]);
      expect(c1).toMatchObject({ status: 'running', requestedBy: 'alice', connectorId: a.id });
      expect(c3).toBeUndefined();

      await tests.finish(r1.id, 'succeeded', { ok: true, message: 'Connected', latencyMs: 20 });
      expect(await tests.latest(a.id)).toMatchObject({ id: r1.id, status: 'succeeded', result: { ok: true, message: 'Connected', latencyMs: 20 } });
      const next = await tests.enqueue(a.id, 2, 'alice');
      expect(next.id).not.toBe(r1.id);
      expect((await tests.latest(a.id))?.id).toBe(next.id);
      expect(await tests.latest(randomUUID())).toBeUndefined();
    });

    it('fails tests stuck in running', async () => {
      const { connectors, tests } = await make();
      const a = newConnector();
      await connectors.insert(a);
      const r = await tests.enqueue(a.id, 1, 'alice');
      await tests.claimNext();
      expect(await tests.failStale(new Date(Date.now() - 60_000))).toBe(0);
      expect(await tests.failStale(new Date(Date.now() + 60_000))).toBe(1);
      expect(await tests.latest(a.id)).toMatchObject({ id: r.id, status: 'failed' });
    });

    it('keeps the approved-host list unique, filtered by purpose, and removable', async () => {
      const { hosts } = await make();
      const a = await hosts.add({ hostPattern: 'squash.example.local', purpose: 'connector', internal: true, allowHttp: true });
      await expect(hosts.add({ hostPattern: 'SQUASH.example.local', purpose: 'connector', internal: true, allowHttp: true })).rejects.toMatchObject({ errorClass: 'conflict' });
      await hosts.add({ hostPattern: 'squash.example.local', purpose: 'llm', internal: true, allowHttp: false });
      expect(await hosts.list('connector')).toHaveLength(1);
      expect(await hosts.list()).toHaveLength(2);
      expect((await hosts.remove(a.id))?.hostPattern).toBe('squash.example.local');
      expect(await hosts.remove(a.id)).toBeUndefined();
      expect(await hosts.list('connector')).toEqual([]);
    });
  });
}
