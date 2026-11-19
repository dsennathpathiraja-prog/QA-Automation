import { describe, expect, it } from 'vitest';
import { ConnectorService, connectorSecretLocator } from '@qa/application';
import { ProviderRegistry, createDefaultCapabilityRegistry } from '@qa/connector-sdk';
import { InMemorySecretStore, sampleProvider, squashProvider } from '@qa/infrastructure';
import { InMemoryAuditSink, InMemoryConnectorRepository, InMemoryHostRepository, InMemoryTestQueue } from '../src';

const actor = { id: 'admin-1' };
const CANARY = 'demo-CANARY-9f3a7c1e-do-not-leak';

function setup() {
  const capabilities = createDefaultCapabilityRegistry();
  const providers = new ProviderRegistry(capabilities);
  providers.register(sampleProvider);
  providers.register(squashProvider);
  const connectors = new InMemoryConnectorRepository();
  const tests = new InMemoryTestQueue();
  const hosts = new InMemoryHostRepository();
  const audit = new InMemoryAuditSink();
  const secrets = new InMemorySecretStore();
  const service = new ConnectorService({ connectors, tests, secrets, providers, capabilities, hosts, audit });
  return { connectors, tests, hosts, audit, secrets, service };
}

const sample = (s: ReturnType<typeof setup>, over: Record<string, unknown> = {}) =>
  s.service.create(actor, { providerKey: 'sample-work-items', name: 'Demo source', config: { projectName: 'Retail Web' }, secrets: { demoKey: CANARY }, ...over });

describe('provider descriptors drive the wizard', () => {
  it('lists providers with config fields, credential fields, steps and capability access', () => {
    const squash = setup().service.providers().find((p) => p.providerKey === 'squash-tm')!;
    expect(squash.configFields).toEqual([
      { name: 'baseUrl', label: expect.stringContaining('SquashTM address'), type: 'url', required: true },
      { name: 'projectName', label: expect.stringContaining('project name'), type: 'text', required: false },
      { name: 'projectId', label: expect.stringContaining('project id'), type: 'text', required: false },
    ]);
    expect(squash.authMethods).toEqual([{ key: 'api_token', label: expect.stringContaining('READ_WRITE'), recommended: true, fields: [{ name: 'token', label: 'API token', type: 'secret', required: true }] }]);
    expect(squash.steps.map((x) => x.key)).toEqual(['connection', 'credentials', 'test', 'probe', 'review']);
    expect(squash.capabilities.find((c) => c.id === 'tm.testcase.upsert')?.access).toBe('write');
  });
});

describe('credentials are accepted once and never come back', () => {
  it('keeps the canary out of every response, audit entry and stored setting', async () => {
    const s = setup();
    const created = await sample(s);
    const replaced = await s.service.replaceCredentials(actor, created.id, { demoKey: `${CANARY}-v2` });
    const out = JSON.stringify([created, replaced, await s.service.get(created.id, { includeConfig: true }), await s.service.get(created.id, { includeConfig: false }), await s.service.list(), s.audit.entries, [...s.connectors.rows.values()]]);
    expect(out).not.toContain('CANARY');
    expect(created.hasCredentials).toBe(true);
    expect((await s.secrets.lease(connectorSecretLocator(created.id))).value.demoKey).toBe(`${CANARY}-v2`);
  });

  it('does not echo a rejected credential or a credential typed into settings', async () => {
    const s = setup();
    const short = await sample(s, { secrets: { demoKey: 'x' } }).catch((e: Error) => e);
    expect(short).toMatchObject({ errorClass: 'validation' });
    expect((short as Error).message).toContain('demoKey');
    expect((short as Error).message).not.toContain('"x"');
    const inSettings = await sample(s, { config: { projectName: 'p', apiToken: CANARY } }).catch((e: Error) => e);
    expect(inSettings).toMatchObject({ errorClass: 'validation' });
    expect((inSettings as Error).message).not.toContain(CANARY);
    expect(await s.connectors.list()).toEqual([]);
  });

  it('leaves no credentials behind when the connector cannot be created', async () => {
    const s = setup();
    await sample(s);
    await expect(sample(s, { secrets: { demoKey: `${CANARY}-orphan` } })).rejects.toMatchObject({ errorClass: 'conflict' });
    expect(s.secrets.size).toBe(1);
  });

  it('requires credentials when the provider uses them', async () => {
    const s = setup();
    await expect(sample(s, { secrets: undefined })).rejects.toMatchObject({ errorClass: 'validation' });
  });

  it('hides settings from callers who may only view status', async () => {
    const s = setup();
    const c = await sample(s);
    expect((await s.service.get(c.id, { includeConfig: false })).config).toBeUndefined();
    expect((await s.service.get(c.id, { includeConfig: true })).config).toEqual({ projectName: 'Retail Web' });
  });
});

describe('connector lifecycle', () => {
  it('creates read-only drafts, rejects duplicates and unknown providers', async () => {
    const s = setup();
    const c = await sample(s);
    expect(c).toMatchObject({ accessMode: 'read_only', status: 'draft', enabled: false });
    await expect(sample(s)).rejects.toMatchObject({ errorClass: 'conflict' });
    await expect(sample(s, { providerKey: 'nope' })).rejects.toMatchObject({ errorClass: 'unsupported' });
    await expect(sample(s, { name: 'x' })).rejects.toMatchObject({ errorClass: 'validation' });
  });

  it('forces a retest and disables the connector when settings or credentials change', async () => {
    const s = setup();
    const c = await sample(s);
    await s.connectors.update(c.id, { status: 'connected', enabled: true });
    expect(await s.service.update(actor, c.id, { name: 'Renamed demo' })).toMatchObject({ status: 'connected', enabled: true, name: 'Renamed demo' });
    expect(await s.service.update(actor, c.id, { config: { projectName: 'Retail Web' } })).toMatchObject({ status: 'connected', enabled: true });
    expect(await s.service.update(actor, c.id, { config: { projectName: 'Other' } })).toMatchObject({ status: 'draft', enabled: false, configVersion: 2 });
    await s.connectors.update(c.id, { status: 'connected', enabled: true });
    expect(await s.service.replaceCredentials(actor, c.id, { demoKey: 'demo-new-key-1' })).toMatchObject({ status: 'draft', enabled: false, configVersion: 3 });
  });

  it('enables only after a successful test and disables on request', async () => {
    const s = setup();
    const c = await sample(s);
    await expect(s.service.enable(actor, c.id)).rejects.toMatchObject({ errorClass: 'conflict' });
    await s.connectors.update(c.id, { status: 'connected' });
    expect((await s.service.enable(actor, c.id)).enabled).toBe(true);
    expect((await s.service.disable(actor, c.id)).enabled).toBe(false);
    expect(s.audit.entries.map((e) => e.action)).toEqual(['connector.create', 'connector.enable', 'connector.disable']);
  });

  it('disconnects, deleting credentials but keeping the record, and refuses further tests', async () => {
    const s = setup();
    const c = await sample(s);
    await s.connectors.update(c.id, { status: 'connected', enabled: true });
    const d = await s.service.disconnect(actor, c.id);
    expect(d).toMatchObject({ status: 'disconnected', enabled: false, hasCredentials: false });
    expect(await s.secrets.exists(connectorSecretLocator(c.id))).toBe(false);
    await expect(s.service.requestTest(actor, c.id)).rejects.toMatchObject({ errorClass: 'conflict' });
    await expect(s.service.update(actor, c.id, { name: 'new name' })).rejects.toMatchObject({ errorClass: 'conflict' });
    expect((await s.service.list()).map((x) => x.id)).toEqual([c.id]);
    await s.service.remove(actor, c.id);
    expect(await s.service.list()).toEqual([]);
  });

  it('only removes drafts and disconnected connectors', async () => {
    const s = setup();
    const c = await sample(s);
    await s.connectors.update(c.id, { status: 'connected', enabled: true });
    await expect(s.service.remove(actor, c.id)).rejects.toMatchObject({ errorClass: 'conflict' });
  });

  it('queues one test at a time and reports not-found for unknown connectors', async () => {
    const s = setup();
    const c = await sample(s);
    const a = await s.service.requestTest(actor, c.id);
    expect((await s.service.requestTest(actor, c.id)).id).toBe(a.id);
    await expect(s.service.get('00000000-0000-4000-8000-000000000000', { includeConfig: true })).rejects.toMatchObject({ errorClass: 'not-found' });
  });
});

describe('approved hosts', () => {
  it('validates host patterns and records who approved them', async () => {
    const s = setup();
    for (const bad of ['http://x.com', 'x.com/path', 'x.com:8080', '*', '*.com', '']) {
      await expect(s.service.approveHost(actor, { hostPattern: bad, internal: false, allowHttp: false }), bad).rejects.toMatchObject({ errorClass: 'validation' });
    }
    await expect(s.service.approveHost(actor, { hostPattern: 'x.example.com', internal: false, allowHttp: true })).rejects.toMatchObject({ errorClass: 'validation' });
    const h = await s.service.approveHost(actor, { hostPattern: ' Squash.Corp.Local ', internal: true, allowHttp: true });
    expect(h.hostPattern).toBe('squash.corp.local');
    expect(s.audit.entries.at(-1)).toMatchObject({ action: 'egress.host.approve', actorId: 'admin-1' });
    await s.service.removeHost(actor, h.id);
    await expect(s.service.removeHost(actor, h.id)).rejects.toMatchObject({ errorClass: 'not-found' });
  });

  it('suggests an approval for an unapproved internal host and flags plain http on an https-only rule', async () => {
    const s = setup();
    const token = 'a'.repeat(30);
    const c = await s.service.create(actor, { providerKey: 'squash-tm', name: 'Squash QA', config: { baseUrl: 'http://squash.corp.local/squash' }, secrets: { token } });
    expect(c.hostIssues).toEqual([{ host: 'squash.corp.local', reason: 'not-approved', suggestion: { hostPattern: 'squash.corp.local', internal: true, allowHttp: true } }]);
    await s.service.approveHost(actor, { hostPattern: '*.corp.local', internal: true, allowHttp: false });
    expect((await s.service.get(c.id, { includeConfig: true })).hostIssues).toEqual([{ host: 'squash.corp.local', reason: 'http-not-allowed', suggestion: { hostPattern: '*.corp.local', internal: true, allowHttp: true } }]);
  });

  it('trims the Squash API token on save and rejects whitespace-only', async () => {
    const s = setup();
    const token = `${'b'.repeat(30)}`;
    const c = await s.service.create(actor, {
      providerKey: 'squash-tm',
      name: 'Squash trim',
      config: { baseUrl: 'http://squash.corp.local/squash' },
      secrets: { token: `  ${token}\n` },
    });
    expect((await s.secrets.lease(connectorSecretLocator(c.id))).value.token).toBe(token);
    await expect(
      s.service.create(actor, {
        providerKey: 'squash-tm',
        name: 'Squash blank',
        config: { baseUrl: 'http://squash.corp.local/squash' },
        secrets: { token: '   ' },
      }),
    ).rejects.toMatchObject({ errorClass: 'validation' });
  });
});
