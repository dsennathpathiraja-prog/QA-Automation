import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorService } from '@qa/application';
import { ProviderRegistry, createDefaultCapabilityRegistry } from '@qa/connector-sdk';
import { EgressPolicy, HardenedHttpClient, InMemorySecretStore, sampleProvider, squashProvider, type EgressRule } from '@qa/infrastructure';
import {
  InMemoryAuditSink,
  InMemoryConnectorRepository,
  InMemoryHostRepository,
  InMemoryTestQueue,
  makeSquashToken,
  startSquashMock,
  type SquashMock,
} from '@qa/testing';
import { ConnectorTester } from '../src';

const actor = { id: 'admin-1' };
const capabilities = createDefaultCapabilityRegistry();
let mock: SquashMock | undefined;

function setup(opts: { hosts?: EgressRule[] } = {}) {
  const connectors = new InMemoryConnectorRepository();
  const tests = new InMemoryTestQueue();
  const hosts = new InMemoryHostRepository();
  const audit = new InMemoryAuditSink();
  const secrets = new InMemorySecretStore();
  const providers = new ProviderRegistry(capabilities);
  providers.register(sampleProvider);
  providers.register(squashProvider);
  const service = new ConnectorService({ connectors, tests, secrets, providers, capabilities, hosts, audit });
  const tester = new ConnectorTester({
    connectors,
    tests,
    secrets,
    providers,
    capabilities,
    audit,
    http: async () => {
      const rules = opts.hosts ?? (await hosts.list('connector')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'connector' as const, internal: h.internal, allowHttp: h.allowHttp, allowLoopback: true }));
      return new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET'] });
    },
  });
  return { connectors, tests, hosts, audit, secrets, service, tester };
}

const createSample = (s: ReturnType<typeof setup>, key = 'demo-secret-key-1') =>
  s.service.create(actor, { providerKey: 'sample-work-items', name: 'Demo source', config: { projectName: 'Retail Web' }, secrets: { demoKey: key } });

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe('Test Connection runs on the worker', () => {
  it('connects, records capabilities and permissions, and lets the connector be enabled', async () => {
    const s = setup();
    const c = await createSample(s);
    expect(c).toMatchObject({ status: 'draft', enabled: false, canEnable: false });
    await expect(s.service.enable(actor, c.id)).rejects.toMatchObject({ errorClass: 'conflict' });

    await s.service.requestTest(actor, c.id);
    expect(await s.tester.runOnce()).toBe('busy');
    expect(await s.tester.runOnce()).toBe('idle');

    const d = await s.service.get(c.id, { includeConfig: true });
    expect(d).toMatchObject({ status: 'connected', canEnable: true, latestTest: { status: 'succeeded', result: { ok: true } } });
    expect(d.permissionReport).toMatchObject({ granted: ['read'], writePermissionsDetected: [] });
    expect(d.capabilities).toEqual([
      { capability: 'workitem.project.list', access: 'read', support: 'supported', reason: undefined, granted: true },
      { capability: 'workitem.read', access: 'read', support: 'supported', reason: undefined, granted: true },
      { capability: 'workitem.search', access: 'read', support: 'partial', reason: 'The demo source matches titles only', granted: true },
    ]);
    const enabled = await s.service.enable(actor, c.id);
    expect(enabled.enabled).toBe(true);
    expect(s.audit.entries.map((e) => e.action)).toEqual(expect.arrayContaining(['connector.create', 'connector.test.request', 'connector.test.succeeded', 'connector.enable']));
  });

  it('reports a rejected credential, marks the connector as error and keeps it disabled', async () => {
    const s = setup();
    const c = await createSample(s, 'not-a-demo-key');
    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    const d = await s.service.get(c.id, { includeConfig: true });
    expect(d.status).toBe('error');
    expect(d.latestTest).toMatchObject({ status: 'failed', result: { ok: false, message: 'The demo key must start with "demo-".' } });
    expect(d.canEnable).toBe(false);
    await expect(s.service.enable(actor, c.id)).rejects.toMatchObject({ errorClass: 'conflict' });
  });

  it('disables a connector whose retest fails', async () => {
    const s = setup();
    const c = await createSample(s);
    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    await s.service.enable(actor, c.id);
    await s.secrets.put(`connectors/${c.id}/credentials`, { demoKey: 'revoked-key-xx' });
    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    expect(await s.service.get(c.id, { includeConfig: true })).toMatchObject({ status: 'error', enabled: false });
  });

  it('refuses a stale request when settings changed after it was queued', async () => {
    const s = setup();
    const c = await createSample(s);
    const req = await s.service.requestTest(actor, c.id);
    await s.service.update(actor, c.id, { config: { projectName: 'Another project' } });
    await s.tester.runOnce();
    expect(await s.tests.latest(c.id)).toMatchObject({ id: req.id, status: 'failed', result: { errorClass: 'conflict' } });
  });

  it('fails cleanly when the connector has no stored credentials', async () => {
    const s = setup();
    const c = await createSample(s);
    await s.secrets.delete(`connectors/${c.id}/credentials`);
    await s.tests.enqueue(c.id, 1, 'admin-1');
    await s.tester.runOnce();
    expect(await s.tests.latest(c.id)).toMatchObject({ status: 'failed', result: { errorClass: 'auth' } });
  });

  it('fails requests left running by a dead worker', async () => {
    const s = setup();
    const c = await createSample(s);
    await s.service.requestTest(actor, c.id);
    await s.tests.claimNext();
    s.tests.rows[0]!.startedAt = new Date(Date.now() - 10 * 60_000);
    await s.tester.runOnce();
    expect(await s.tests.latest(c.id)).toMatchObject({ status: 'failed' });
  });
});

describe('Squash through Test Connection (documentation-based mock)', () => {
  const squash = (s: ReturnType<typeof setup>, token: string, baseUrl: string) =>
    s.service.create(actor, { providerKey: 'squash-tm', name: 'Squash QA', config: { baseUrl }, secrets: { token } });

  it('only reaches Squash once the host is approved, then reports supported, partial and unsupported capabilities', async () => {
    const token = makeSquashToken({ permissions: 'READ', expiresAt: new Date(Date.now() + 100 * 86_400_000) });
    mock = await startSquashMock({ token, permissions: 'READ' });
    const s = setup();
    const c = await squash(s, token, mock.baseUrl);
    expect(c.hostIssues).toEqual([{ host: '127.0.0.1', reason: 'not-approved', suggestion: { hostPattern: '127.0.0.1', internal: true, allowHttp: true } }]);

    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    const blocked = await s.service.get(c.id, { includeConfig: true });
    expect(blocked.status).toBe('error');
    expect(blocked.latestTest?.result?.message).toMatch(/approved-host list/);
    expect(mock.requests).toHaveLength(0);

    await s.service.approveHost(actor, { hostPattern: '127.0.0.1', internal: true, allowHttp: true });
    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    const d = await s.service.get(c.id, { includeConfig: true });
    expect(d.status).toBe('connected');
    expect(d.hostIssues).toEqual([]);
    expect(d.discoveredInfo).toMatchObject({ projectsVisible: 2, tokenPermissions: 'READ' });
    const byCap = Object.fromEntries(d.capabilities.map((x) => [x.capability, x]));
    expect(byCap['tm.project.list']).toMatchObject({ support: 'supported', granted: true });
    expect(byCap['tm.suite.list']).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(token);
  });

  it('accepts a read-write token so generated cases can be stored', async () => {
    const token = makeSquashToken({ permissions: 'READ_WRITE', expiresAt: new Date(Date.now() + 100 * 86_400_000) });
    mock = await startSquashMock({ token, permissions: 'READ_WRITE' });
    const s = setup({ hosts: [{ hostPattern: '127.0.0.1', purpose: 'connector', internal: true, allowHttp: true, allowLoopback: true }] });
    const c = await squash(s, token, mock.baseUrl);
    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    const d = await s.service.get(c.id, { includeConfig: true });
    expect(d.status).toBe('connected');
    expect(d.permissionReport?.writePermissionsDetected).toEqual(['token:READ_WRITE']);
    expect(d.latestTest?.result?.message).toMatch(/Connected to SquashTM/);
    expect(d.canEnable).toBe(true);
  });

  it('shows a wrong token as a failed test without echoing the token', async () => {
    const good = makeSquashToken({ permissions: 'READ' });
    mock = await startSquashMock({ token: good, permissions: 'READ' });
    const s = setup({ hosts: [{ hostPattern: '127.0.0.1', purpose: 'connector', internal: true, allowHttp: true, allowLoopback: true }] });
    const bad = 'y'.repeat(40);
    const c = await squash(s, bad, mock.baseUrl);
    await s.service.requestTest(actor, c.id);
    await s.tester.runOnce();
    const d = await s.service.get(c.id, { includeConfig: true });
    expect(d.status).toBe('error');
    expect(d.latestTest?.result?.message).toMatch(/rejected the API token/);
    expect(JSON.stringify(d)).not.toContain(bad);
  });
});

