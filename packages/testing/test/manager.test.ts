import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { ConnectorProvider } from '@qa/connector-sdk';
import {
  createHarness, execPolicy, makeInstance, makeStubTestManagementProvider, makeStubWorkItemProvider,
  assertProviderContract,
} from '../src';

const WI_CAPS = ['workitem.project.list', 'workitem.search', 'workitem.read'];
const step = { type: 'step' as const, id: 'read_story', executionId: 'ex1', stepId: 's1' };

function setup(over: { items?: Parameters<typeof makeStubWorkItemProvider>[0]; behavior?: Parameters<typeof makeStubWorkItemProvider>[1]; instance?: Partial<Parameters<typeof makeInstance>[0]>; policy?: Parameters<typeof execPolicy>[0]; defaults?: Parameters<typeof createHarness>[0]['defaults'] } = {}) {
  const items = over.items ?? [{ id: '42', title: 'Guest checkout', description: 'desc' }];
  const h = createHarness({
    providers: [makeStubWorkItemProvider(items, over.behavior)],
    instances: [makeInstance({ id: 'wi1', providerKey: 'stub-work-items', category: 'work-item', secretLocator: 'connectors/wi1/token', scope: { project: 'p1' }, ...over.instance }, WI_CAPS)],
    policies: { ex1: execPolicy({ boundRoles: { workItemSource: 'wi1' }, ...over.policy }) },
    defaults: over.defaults,
  });
  return h;
}

describe('ConnectorExecutionManager', () => {
  it('invokes via role, leases the secret, audits and releases the lease', async () => {
    const seen: { value?: string } = {};
    const h = setup({ behavior: { sawToken: seen } });
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const out = await h.manager.invoke<{ id: string; title: string }>({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step });
    expect(out.title).toBe('Guest checkout');
    expect(seen.value).toBe('tok-12345678');
    expect(h.log.entries).toHaveLength(1);
    expect(h.log.entries[0]).toMatchObject({ outcome: 'ok', capability: 'workitem.read', connectorInstanceId: 'wi1', access: 'read' });
    expect(h.log.entries[0]!.requestDigest).toMatch(/^sha256:/);
  });

  it('redacts secrets that leak into provider output', async () => {
    const h = setup({ items: [{ id: '1', title: 'leak tok-12345678 here' }] });
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const out = await h.manager.invoke<{ title: string }>({ role: 'workItemSource', capability: 'workitem.read', input: { id: '1' }, actor: step });
    expect(out.title).toBe('leak [REDACTED] here');
  });

  it('denies capabilities on the execution deny-list and logs the denial', async () => {
    const h = setup({ policy: { capabilityDeny: ['workitem.*'] } });
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step })).rejects.toMatchObject({ errorClass: 'denied' });
    expect(h.log.entries[0]).toMatchObject({ outcome: 'denied' });
    expect(h.log.entries[0]!.denialReason).toMatch(/denied by execution policy/);
  });

  it('denies unbound roles, wrong instances and steps without an execution policy', async () => {
    const h = setup();
    await expect(h.manager.invoke({ role: 'other', capability: 'workitem.read', input: { id: '1' }, actor: step })).rejects.toMatchObject({ errorClass: 'denied' });
    await expect(h.manager.invoke({ connectorInstanceId: 'wi1', capability: 'workitem.read', input: { id: '1' }, actor: { ...step, executionId: 'unknown' } })).rejects.toMatchObject({ errorClass: 'denied' });
    await expect(h.manager.invoke({ capability: 'workitem.read', input: { id: '1' }, actor: step })).rejects.toMatchObject({ errorClass: 'validation' });
  });

  it('requires an explicit grant for agents', async () => {
    const h = setup({ policy: { agentGrants: { planner: [{ capability: 'workitem.read' }] } } });
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const agent = { ...step, type: 'agent' as const, agentKey: 'planner' };
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.search', input: { query: 'x' }, actor: agent })).rejects.toMatchObject({ errorClass: 'denied' });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: agent })).resolves.toBeTruthy();
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: { ...agent, agentKey: 'unknown' } })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('enforces connector scope', async () => {
    const h = setup();
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { project: 'other', id: '42' }, actor: step })).rejects.toThrow(/outside the connector scope/);
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { project: 'p1', id: '42' }, actor: step })).resolves.toBeTruthy();
  });

  it('refuses disabled or errored instances', async () => {
    for (const inst of [{ enabled: false }, { status: 'error' as const }]) {
      const h = setup({ instance: inst });
      await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
      await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step })).rejects.toMatchObject({ errorClass: 'denied' });
    }
  });

  it('refuses capabilities not in the instance effective set', async () => {
    const h = setup({ instance: { effectiveCapabilities: new Set(['workitem.read']) } });
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.search', input: { query: 'x' }, actor: step })).rejects.toThrow(/not supported or not permitted/);
  });

  it('validates input and output against the capability schema', async () => {
    const h = setup();
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { nope: 1 }, actor: step })).rejects.toMatchObject({ errorClass: 'validation' });
    const bad = setup({ items: [{ id: '1' } as never] });
    await bad.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    await expect(bad.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '1' }, actor: step })).rejects.toThrow(/invalid output/);
  });

  it('fills scm.code.search repo from the bound source-repo connector config', async () => {
    const seen: { repo?: string; query?: string } = {};
    const provider: ConnectorProvider = {
      manifest: {
        providerKey: 'stub-repo',
        category: 'source-repo',
        displayName: 'Stub repo',
        description: 'test',
        authMethods: [],
        capabilities: ['scm.code.search', 'scm.file.read', 'scm.tree.list', 'scm.branch.list'],
        requiredPermissions: [],
        accessModePolicy: 'read_only_enforced',
        requiresInternet: false,
        verification: 'live-capable',
        wizard: [],
      },
      configSchema: z.object({ repo: z.string().optional() }),
      secretSchema: z.object({}),
      create: () => ({
        testConnection: async () => ({ ok: true, message: '' }),
        probeCapabilities: async () => [],
        inspectPermissions: async () => ({ granted: [], writePermissionsDetected: [] }),
        handle: async (cap, input) => {
          const body = (input ?? {}) as { repo?: string; query?: string; path?: string };
          if (cap.id === 'scm.code.search') {
            seen.repo = body.repo;
            seen.query = body.query;
            return { items: [{ path: 'src/a.ts', snippet: 'login' }] };
          }
          return { path: body.path ?? '', content: '', truncated: false };
        },
        dispose: async () => undefined,
      }),
    };
    const h = createHarness({
      providers: [provider],
      instances: [makeInstance({
        id: 'repo1',
        providerKey: 'stub-repo',
        category: 'source-repo',
        config: { repo: 'shop' },
        accessMode: 'read_only',
      }, ['scm.code.search', 'scm.file.read', 'scm.tree.list', 'scm.branch.list'])],
      policies: { ex1: execPolicy({ boundRoles: { sourceRepo: 'repo1' } }) },
    });
    await h.manager.invoke({
      role: 'sourceRepo',
      capability: 'scm.code.search',
      input: { query: 'login' },
      actor: step,
    });
    expect(seen).toEqual({ repo: 'shop', query: 'login' });
  });

  it('rate limits per instance and opens the circuit after repeated transient failures', async () => {
    const rl = setup({ defaults: { burst: 2, ratePerSec: 0.0001 } });
    await rl.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const call = () => rl.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step });
    await call();
    await call();
    await expect(call()).rejects.toMatchObject({ errorClass: 'rate-limited', retryable: true });

    const failing = setup({ behavior: { failWith: new PlatformError('transient', 'boom') }, defaults: { breakerThreshold: 2, breakerCooldownMs: 60_000 } });
    await failing.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const f = () => failing.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step });
    await expect(f()).rejects.toThrow('boom');
    await expect(f()).rejects.toThrow('boom');
    await expect(f()).rejects.toThrow(/circuit breaker/);
    failing.clock.advance(61_000);
    await expect(f()).rejects.toThrow('boom'); // half-open probe reaches the adapter
  });

  it('does not count auth/validation errors toward the breaker', async () => {
    const h = setup({ behavior: { failWith: new PlatformError('auth', 'bad token') }, defaults: { breakerThreshold: 1 } });
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    for (let i = 0; i < 3; i += 1) {
      await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step })).rejects.toThrow('bad token');
    }
  });

  it('resetCircuit closes an open breaker (Test connection Success path)', async () => {
    const failing = setup({ behavior: { failWith: new PlatformError('transient', 'boom') }, defaults: { breakerThreshold: 1, breakerCooldownMs: 60_000 } });
    await failing.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const f = () => failing.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor: step });
    await expect(f()).rejects.toThrow('boom');
    await expect(f()).rejects.toThrow(/circuit breaker/);
    failing.manager.resetCircuit('wi1');
    await expect(f()).rejects.toThrow('boom'); // probe reaches adapter again
  });

  it('does not open the breaker on browser.evaluate / browser.wait soft failures', async () => {
    let evalCalls = 0;
    const browserProvider: ConnectorProvider = {
      manifest: {
        providerKey: 'stub-browser',
        category: 'browser-automation',
        displayName: 'Stub browser',
        description: 'test',
        authMethods: [],
        capabilities: ['browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.wait', 'browser.evaluate', 'browser.screenshot'],
        requiredPermissions: [],
        accessModePolicy: 'read_write',
        requiresInternet: false,
        verification: 'live-capable',
        wizard: [],
      },
      configSchema: z.object({}),
      secretSchema: z.object({}).strict(),
      create: () => ({
        testConnection: async () => ({ ok: true, message: '' }),
        probeCapabilities: async () => [],
        inspectPermissions: async () => ({ granted: [], writePermissionsDetected: [] }),
        handle: async (cap) => {
          if (cap.id === 'browser.session.open') return { sessionId: 's1' };
          if (cap.id === 'browser.evaluate' || cap.id === 'browser.wait') {
            evalCalls += 1;
            throw new PlatformError('transient', 'evaluate boom');
          }
          if (cap.id === 'browser.snapshot') return { accessibilityTree: '- button "Pay"', url: 'https://shop.example.com', title: 'Shop' };
          return {};
        },
        dispose: async () => undefined,
      }),
    };
    const caps = ['browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.wait', 'browser.evaluate', 'browser.screenshot'];
    const h = createHarness({
      providers: [browserProvider],
      instances: [makeInstance({ id: 'br1', providerKey: 'stub-browser', category: 'browser-automation' }, caps)],
      policies: { ex1: execPolicy({ boundRoles: { browserAutomation: 'br1' } }) },
      defaults: { breakerThreshold: 2, breakerCooldownMs: 60_000 },
    });
    const actor = { type: 'step' as const, id: 'explore', executionId: 'ex1', stepId: 's1' };
    for (let i = 0; i < 4; i += 1) {
      await expect(h.manager.invoke({
        role: 'browserAutomation',
        capability: 'browser.evaluate',
        input: { sessionId: 's1', script: '() => 1' },
        actor,
      })).rejects.toThrow('evaluate boom');
    }
    expect(evalCalls).toBe(4);
    // Soft failures must not open the breaker — snapshot still works.
    await expect(h.manager.invoke({
      role: 'browserAutomation',
      capability: 'browser.snapshot',
      input: { sessionId: 's1' },
      actor,
    })).resolves.toMatchObject({ accessibilityTree: expect.stringMatching(/Pay/) });
  });

  it('times out slow adapters as transient', async () => {
    const slow: ConnectorProvider = {
      ...makeStubWorkItemProvider([]),
      create: () => ({
        testConnection: async () => ({ ok: true, message: '' }), probeCapabilities: async () => [], inspectPermissions: async () => ({ granted: [], writePermissionsDetected: [] }),
        handle: () => new Promise(() => undefined), dispose: async () => undefined,
      }),
    };
    const h = createHarness({
      providers: [slow],
      instances: [makeInstance({ id: 'wi1', providerKey: 'stub-work-items', category: 'work-item' }, WI_CAPS)],
      policies: { ex1: execPolicy({ boundRoles: { workItemSource: 'wi1' } }) },
      defaults: { timeoutMs: 25 },
    });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '1' }, actor: step })).rejects.toMatchObject({ errorClass: 'transient' });
  });

  it('only lets users with connector permissions run interactive calls, on named instances', async () => {
    const h = setup();
    await h.secrets.put('connectors/wi1/token', { token: 'tok-12345678' });
    const base = { capability: 'workitem.project.list', input: {} } as const;
    await expect(h.manager.invoke({ ...base, actor: { type: 'user', id: 'u', permissions: [] }, connectorInstanceId: 'wi1' })).rejects.toMatchObject({ errorClass: 'denied' });
    await expect(h.manager.invoke({ ...base, actor: { type: 'user', id: 'u', permissions: ['connector.manage'] } })).rejects.toBeTruthy();
    await expect(h.manager.invoke({ ...base, actor: { type: 'user', id: 'u', permissions: ['connector.manage'] }, connectorInstanceId: 'wi1' })).resolves.toBeTruthy();
  });
});

describe('write capabilities, idempotency and read-only instances', () => {
  const tm = () => {
    const store = new Map<string, { id: string; name: string }>();
    const calls = { creates: 0 };
    const h = createHarness({
      providers: [makeStubTestManagementProvider(store, calls)],
      instances: [
        makeInstance({ id: 'tm1', providerKey: 'stub-tm', category: 'test-management' }, ['tm.testcase.upsert', 'tm.testcase.search']),
        makeInstance({ id: 'tmro', providerKey: 'stub-tm', category: 'test-management', accessMode: 'read_only' }, ['tm.testcase.upsert']),
      ],
      policies: { ex1: execPolicy({ boundRoles: { testManagement: 'tm1', ro: 'tmro' } }) },
    });
    return { h, store, calls };
  };
  const input = { reference: 'QAP-US42-SC1', name: 'Guest can check out' };

  it('requires an idempotency key for key-required writes', async () => {
    const { h } = tm();
    await expect(h.manager.invoke({ role: 'testManagement', capability: 'tm.testcase.upsert', input, actor: step })).rejects.toThrow(/idempotency key/);
  });

  it('retries with the same key do not create duplicates', async () => {
    const { h, calls, store } = tm();
    const call = () => h.manager.invoke<{ id: string; created: boolean }>({ role: 'testManagement', capability: 'tm.testcase.upsert', input, idempotencyKey: 'k1', actor: step });
    const a = await call();
    const b = await call();
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(calls.creates).toBe(1);
    expect(store.size).toBe(1);
  });

  it('blocks writes on read-only instances', async () => {
    const { h } = tm();
    await expect(h.manager.invoke({ role: 'ro', capability: 'tm.testcase.upsert', input, idempotencyKey: 'k', actor: step })).rejects.toThrow(/read-only/);
  });
});

describe('provider contract kit', () => {
  it('passes for the stub providers', () => {
    expect(assertProviderContract(makeStubWorkItemProvider([]))).toEqual([]);
    expect(assertProviderContract(makeStubTestManagementProvider(new Map(), { creates: 0 }))).toEqual([]);
  });

  it('flags a source-repo provider that exposes a write capability', () => {
    const bad: ConnectorProvider = {
      ...makeStubWorkItemProvider([]),
      manifest: { ...makeStubWorkItemProvider([]).manifest, providerKey: 'evil-repo', category: 'source-repo', accessModePolicy: 'read_only_enforced', capabilities: ['tm.testcase.upsert'] },
      configSchema: z.object({}), secretSchema: z.object({}),
    };
    expect(assertProviderContract(bad).join()).toMatch(/category/);
  });
});
