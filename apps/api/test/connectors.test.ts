import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConnectorService } from '@qa/application';
import { ProviderRegistry, createDefaultCapabilityRegistry } from '@qa/connector-sdk';
import { InMemorySecretStore, sampleProvider, squashProvider } from '@qa/infrastructure';
import { InMemoryAuditSink, InMemoryConnectorRepository, InMemoryHostRepository, InMemoryOperationLogReader, InMemoryTestQueue } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const CANARY = 'demo-CANARY-4c2e9a7b-never-in-output';
const admin = { 'x-dev-user': 'root', 'x-dev-groups': 'QA-Platform-Admins' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
const lead = { 'x-dev-user': 'lead', 'x-dev-groups': 'QA-Platform-Leads' };
const business = { 'x-dev-user': 'biz', 'x-dev-groups': 'QA-Platform-Users' };

let app: FastifyInstance;
let audit: InMemoryAuditSink;
let secrets: InMemorySecretStore;
let connectors: InMemoryConnectorRepository;
let operations: InMemoryOperationLogReader;
let logged: string[];
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' '))));
  const capabilities = createDefaultCapabilityRegistry();
  const providers = new ProviderRegistry(capabilities);
  providers.register(sampleProvider);
  providers.register(squashProvider);
  connectors = new InMemoryConnectorRepository();
  audit = new InMemoryAuditSink();
  secrets = new InMemorySecretStore();
  operations = new InMemoryOperationLogReader();
  const service = new ConnectorService({ connectors, tests: new InMemoryTestQueue(), secrets, providers, capabilities, hosts: new InMemoryHostRepository(), audit });
  app = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', connectors: { connectors: service, operations } });
});

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: unknown) => app.inject({ method, url, headers, payload: payload as object | undefined });
const create = (over: Record<string, unknown> = {}) =>
  call('POST', '/api/v1/connectors', admin, { providerKey: 'sample-work-items', name: 'Demo source', config: { projectName: 'Retail Web' }, secrets: { demoKey: CANARY }, ...over });

describe('connector API access', () => {
  it('lets every status viewer list providers and connectors, but only managers change anything', async () => {
    const made = (await create()).json();
    for (const who of [engineer, lead, admin]) {
      expect((await call('GET', '/api/v1/connectors', who)).statusCode).toBe(200);
      expect((await call('GET', '/api/v1/connector-providers', who)).statusCode).toBe(200);
      expect((await call('GET', `/api/v1/connectors/${made.id}`, who)).statusCode).toBe(200);
    }
    expect((await call('GET', '/api/v1/connectors', business)).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/connectors')).statusCode).toBe(401);
    for (const who of [engineer, lead, business]) {
      expect((await call('POST', '/api/v1/connectors', who, {})).statusCode, 'create').toBe(403);
      expect((await call('PATCH', `/api/v1/connectors/${made.id}`, who, { name: 'xxxxx' })).statusCode, 'update').toBe(403);
      expect((await call('PUT', `/api/v1/connectors/${made.id}/credentials`, who, { secrets: { demoKey: 'demo-x1234567' } })).statusCode, 'credentials').toBe(403);
      for (const a of ['test', 'enable', 'disable', 'disconnect']) expect((await call('POST', `/api/v1/connectors/${made.id}/${a}`, who)).statusCode, a).toBe(403);
      expect((await call('DELETE', `/api/v1/connectors/${made.id}`, who)).statusCode, 'delete').toBe(403);
      expect((await call('GET', '/api/v1/egress/hosts', who)).statusCode, 'hosts').toBe(403);
    }
  });

  it('shows the operation log to auditors only, and host approval to administrators only', async () => {
    const made = (await create()).json();
    expect((await call('GET', `/api/v1/connectors/${made.id}/operations`, lead)).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/connectors/${made.id}/operations`, admin)).statusCode).toBe(200);
    expect((await call('GET', `/api/v1/connectors/${made.id}/operations`, engineer)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/egress/hosts', lead, { hostPattern: 'squash.corp.local', internal: true, allowHttp: true })).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/egress/hosts', admin, { hostPattern: 'squash.corp.local', internal: true, allowHttp: true })).statusCode).toBe(201);
    expect((await call('GET', '/api/v1/egress/hosts', admin)).json().items).toHaveLength(1);
  });

  it('shows settings only to managers', async () => {
    const made = (await create()).json();
    expect((await call('GET', `/api/v1/connectors/${made.id}`, admin)).json().config).toEqual({ projectName: 'Retail Web' });
    expect((await call('GET', `/api/v1/connectors/${made.id}`, engineer)).json().config).toBeUndefined();
  });

  it('describes providers so the wizard can render itself', async () => {
    const items = (await call('GET', '/api/v1/connector-providers', engineer)).json().items;
    const squash = items.find((p: { providerKey: string }) => p.providerKey === 'squash-tm');
    expect(squash.steps.map((s: { key: string }) => s.key)).toEqual(['connection', 'credentials', 'test', 'probe', 'review']);
    expect(squash.configFields[0]).toMatchObject({ name: 'baseUrl', type: 'url' });
  });
});

describe('connector API behaviour', () => {
  it('walks create, test request, enable and disconnect with clear errors', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ status: 'draft', enabled: false, accessMode: 'read_only', hasCredentials: true });

    expect((await create()).json()).toEqual({ error: { class: 'conflict', message: 'A connector named "Demo source" already exists for this provider.' } });
    expect((await call('POST', `/api/v1/connectors/${c.id}/enable`, admin)).statusCode).toBe(409);
    const t = await call('POST', `/api/v1/connectors/${c.id}/test`, admin);
    expect(t.statusCode).toBe(202);
    expect(t.json().status).toBe('pending');
    expect((await call('GET', `/api/v1/connectors/${c.id}`, admin)).json().latestTest.status).toBe('pending');

    await connectors.update(c.id, { status: 'connected' });
    expect((await call('POST', `/api/v1/connectors/${c.id}/enable`, admin)).json().enabled).toBe(true);
    expect((await call('POST', `/api/v1/connectors/${c.id}/disconnect`, admin)).json()).toMatchObject({ status: 'disconnected', enabled: false, hasCredentials: false });
    expect((await call('DELETE', `/api/v1/connectors/${c.id}`, admin)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/connectors/${c.id}`, admin)).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/connectors/not-an-id', admin)).statusCode).toBe(404);
  });

  it('rejects malformed requests without echoing them', async () => {
    const bad = await call('POST', '/api/v1/connectors', admin, { providerKey: 5, secrets: { demoKey: CANARY } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('CANARY');
    expect((await create({ providerKey: 'nope' })).statusCode).toBe(400);
    expect((await create({ name: 'ab' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/egress/hosts', admin, { hostPattern: 'http://x', internal: true, allowHttp: true })).statusCode).toBe(400);
  });

  it('pages the operation log newest first', async () => {
    const made = (await create()).json();
    for (let i = 1; i <= 5; i += 1) operations.rows.push({ seq: i, at: new Date(1_700_000_000_000 + i), actorType: 'step', actorId: 's', connectorInstanceId: made.id, capability: 'workitem.read', outcome: i % 2 ? 'ok' : 'denied', durationMs: i });
    const first = (await call('GET', `/api/v1/connectors/${made.id}/operations?limit=2`, admin)).json();
    expect(first.items.map((r: { seq: number }) => r.seq)).toEqual([5, 4]);
    expect(first.nextBeforeSeq).toBe(4);
    const rest = (await call('GET', `/api/v1/connectors/${made.id}/operations?limit=10&before=${first.nextBeforeSeq}`, admin)).json();
    expect(rest.items.map((r: { seq: number }) => r.seq)).toEqual([3, 2, 1]);
    expect(rest.nextBeforeSeq).toBeUndefined();
    expect((await call('GET', `/api/v1/connectors/${made.id}/operations?outcome=denied`, admin)).json().items).toHaveLength(2);
  });
});

describe('canary: a credential value never appears in any response, audit entry or log line', () => {
  it('holds across every route and every role', async () => {
    const outputs: string[] = [];
    const record = async (p: ReturnType<typeof call>) => {
      const r = await p;
      outputs.push(r.body, JSON.stringify(r.headers));
    };
    const made = (await create()).json();
    outputs.push(JSON.stringify(made));
    await record(create());
    await record(create({ secrets: { demoKey: CANARY.slice(0, 5) } }));
    await record(create({ config: { projectName: 'p', apiToken: CANARY } }));
    await record(call('POST', '/api/v1/connectors', admin, { providerKey: 'sample-work-items', name: 'zzzz', secrets: [CANARY] }));
    await record(call('PUT', `/api/v1/connectors/${made.id}/credentials`, admin, { secrets: { demoKey: `${CANARY}-rotated` } }));
    await record(call('PUT', `/api/v1/connectors/${made.id}/credentials`, admin, { secrets: { wrong: CANARY } }));
    await record(call('PATCH', `/api/v1/connectors/${made.id}`, admin, { config: { projectName: 'Changed', password: CANARY } }));
    await record(call('POST', `/api/v1/connectors/${made.id}/test`, admin));
    for (const who of [admin, lead, engineer, business]) {
      for (const url of ['/api/v1/connectors', '/api/v1/connector-providers', `/api/v1/connectors/${made.id}`, `/api/v1/connectors/${made.id}/operations`, '/api/v1/egress/hosts', '/api/v1/me']) await record(call('GET', url, who));
    }
    await record(call('POST', `/api/v1/connectors/${made.id}/disconnect`, admin));

    expect(outputs.length).toBeGreaterThan(30);
    for (const o of outputs) expect(o).not.toContain('CANARY');
    expect(JSON.stringify(audit.entries)).not.toContain('CANARY');
    expect(logged.join('\n')).not.toContain('CANARY');
    expect(JSON.stringify([...connectors.rows.values()])).not.toContain('CANARY');
    expect(secrets.size).toBe(0);
  });
});
