import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { ConnectorService } from '@qa/application';
import { ProviderRegistry, createDefaultCapabilityRegistry } from '@qa/connector-sdk';
import { EgressPolicy, HardenedHttpClient, InMemorySecretStore, githubProvider } from '@qa/infrastructure';
import { InMemoryAuditSink, InMemoryConnectorRepository, InMemoryHostRepository, InMemoryTestQueue } from '@qa/testing';
import { ConnectorTester } from '../src';

const TOKEN = 'readonly-token-value-0001';

async function withGitHub(scopes: string | null) {
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    const body = path.startsWith('/user') ? { login: 'ada' } : { permissions: { pull: true, push: true, admin: true } };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (scopes !== null) headers['x-oauth-scopes'] = scopes;
    res.writeHead(200, headers);
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const capabilities = createDefaultCapabilityRegistry();
  const providers = new ProviderRegistry(capabilities);
  providers.register(githubProvider);
  const connectors = new InMemoryConnectorRepository();
  const tests = new InMemoryTestQueue();
  const hosts = new InMemoryHostRepository();
  const secrets = new InMemorySecretStore();
  const service = new ConnectorService({ connectors, tests, secrets, providers, capabilities, hosts, audit: new InMemoryAuditSink() });
  const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules: [{ hostPattern: '127.0.0.1', purpose: 'connector', internal: true, allowHttp: true, allowLoopback: true }], profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET', 'HEAD'] });
  const tester = new ConnectorTester({ connectors, tests, secrets, providers, capabilities, http: async () => http });
  const created = await service.create({ id: 'admin' }, { projectId: '01900000-0000-7000-8000-000000000001', providerKey: 'github', name: 'GitHub shop', config: { baseUrl: `http://127.0.0.1:${port}`, org: 'acme', repo: 'shop' }, secrets: { token: TOKEN } });
  await service.approveHost({ id: 'admin' }, { hostPattern: '127.0.0.1', internal: true, allowHttp: true });
  await service.requestTest({ id: 'admin' }, created.id);
  await tester.runOnce();
  const detail = await service.get(created.id, { includeConfig: true });
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return detail;
}

describe('GitHub read-only gate', () => {
  it('blocks a token that can push and shows the read-only checks', async () => {
    const detail = await withGitHub('repo');
    expect(detail.status).toBe('error');
    expect(detail.canEnable).toBe(false);
    expect(detail.permissionReport?.writePermissionsDetected).toEqual(expect.arrayContaining(['repo']));
    const layers = Object.fromEntries((detail.readOnlyLayers ?? []).map((l) => [l.id, l.state]));
    expect(layers).toMatchObject({ 'access-mode': 'holds', catalog: 'holds', http: 'holds', credential: 'blocked', host: 'holds', git: 'holds' });
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
  });

  it('accepts a fine-grained read token when the account itself can push', async () => {
    const detail = await withGitHub(null);
    expect(detail.status).toBe('connected');
    expect(detail.canEnable).toBe(true);
    expect(detail.permissionReport?.writePermissionsDetected).toEqual([]);
  });

  it('lets a read-only token become connected', async () => {
    const detail = await withGitHub('read:org');
    expect(detail.status).toBe('connected');
    expect(detail.canEnable).toBe(true);
    expect(detail.readOnlyLayers?.find((l) => l.id === 'credential')?.state).toBe('holds');
  });
});
