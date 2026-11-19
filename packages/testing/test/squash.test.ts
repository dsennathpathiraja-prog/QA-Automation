import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultCapabilityRegistry, type ConnectorClient } from '@qa/connector-sdk';
import { PlatformError } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, htmlToText, squashProvider, SQUASH_SUPPORTED_CAPABILITIES, type EgressRule } from '@qa/infrastructure';
import { assertProviderContract, createHarness, execPolicy, makeInstance, makeSquashToken, startSquashMock, type SquashMock } from '../src';

const caps = createDefaultCapabilityRegistry();
const token = makeSquashToken({ permissions: 'READ', expiresAt: new Date(Date.now() + 100 * 86_400_000) });
let mock: SquashMock;

function connect(over: { baseUrl?: string; token?: string; config?: Record<string, unknown> } = {}): ConnectorClient {
  const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
  const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET'] });
  return squashProvider.create({ baseUrl: over.baseUrl ?? mock.baseUrl, ...over.config }, { value: { token: over.token ?? token }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
}
const call = (c: ConnectorClient, id: string, input: Record<string, unknown> = {}, scope = {}) => c.handle(caps.get(id), input, { instanceId: 'sq', config: {}, scope });

beforeEach(async () => {
  mock = await startSquashMock({ token, permissions: 'READ' });
});
afterEach(async () => {
  await mock.close();
});

describe('Squash provider against the documentation-based mock', () => {
  it('declares only capabilities that exist in the catalog and that Squash documents', () => {
    expect(squashProvider.manifest.capabilities).toEqual([...SQUASH_SUPPORTED_CAPABILITIES]);
    expect(squashProvider.manifest.capabilities.filter((id) => caps.get(id).access === 'write')).toEqual(['tm.testcase.upsert']);
    expect(squashProvider.manifest.authMethods.map((a) => a.key)).toEqual(['api_token']);
  });

  it('tests the connection and reports token permission and days to expiry', async () => {
    const r = await connect().testConnection();
    expect(r.ok).toBe(true);
    expect(r.discovered).toMatchObject({ projectsVisible: 2, tokenPermissions: 'READ', tokenExpiryWarning: false });
    expect(r.discovered!.tokenDaysToExpiry).toBeGreaterThan(90);
  });

  it('warns when the token is close to expiry', async () => {
    const soon = makeSquashToken({ permissions: 'READ', expiresAt: new Date(Date.now() + 3 * 86_400_000) });
    await mock.close();
    mock = await startSquashMock({ token: soon });
    const r = await connect({ token: soon }).testConnection();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/expires in \d day/);
    expect(r.discovered).toMatchObject({ tokenExpiryWarning: true });
  });

  it('flags a READ_WRITE token as a write permission', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    expect((await connect({ token: rw }).inspectPermissions()).writePermissionsDetected).toEqual(['token:READ_WRITE']);
    expect((await connect().inspectPermissions()).writePermissionsDetected).toEqual([]);
  });

  it('turns a wrong token into a clear auth error, and never sends the token anywhere but the header', async () => {
    const bad = connect({ token: 'x'.repeat(30) });
    const r = await bad.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the API token/);
    expect(r.message).not.toContain('xxxx');
    await expect(call(bad, 'tm.project.list')).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('probes capabilities from real endpoints and declares what Squash does not offer', async () => {
    const probe = await connect().probeCapabilities();
    const by = Object.fromEntries(probe.map((p) => [p.capability, p]));
    expect(by['tm.testcase.list']!.support).toBe('supported');
    expect(by['tm.requirement.read']!.support).toBe('supported');
    expect(by['tm.testcase.search']).toMatchObject({ support: 'partial' });
    for (const id of ['tm.tag.list', 'tm.customfield.list', 'tm.suite.list']) expect(by[id]!.support).toBe('unsupported');
    expect(mock.nonGetRequests()).toEqual([]);
  });

  it('reads test cases through a project when the global list is refused', async () => {
    await mock.close();
    mock = await startSquashMock({ token, override: (r) => (r.path.startsWith('/squash/api/rest/latest/test-cases') ? { status: 403 } : undefined) });
    const probe = await connect().probeCapabilities();
    expect(probe.find((p) => p.capability === 'tm.testcase.list')).toMatchObject({ support: 'supported', evidence: { endpoint: 'GET /projects/1/test-cases' } });
    expect(probe.find((p) => p.capability === 'tm.testcase.read')).toMatchObject({ support: 'supported' });
  });

  it('reports a resource as unsupported when the token owner cannot read it', async () => {
    await mock.close();
    mock = await startSquashMock({ token, override: (r) => (r.path.startsWith('/squash/api/rest/latest/campaigns') ? { status: 403 } : undefined) });
    const probe = await connect().probeCapabilities();
    expect(probe.find((p) => p.capability === 'tm.campaign.list')).toMatchObject({ support: 'unsupported', reason: expect.stringContaining('cannot read') });
  });

  it('lists projects and pages through test cases with a cursor', async () => {
    const c = connect();
    expect(((await call(c, 'tm.project.list')) as any).items).toEqual([{ id: '1', name: 'Retail Web' }, { id: '2', name: 'Back Office' }]);
    const first = (await call(c, 'tm.testcase.list', { project: '1', limit: 2 })) as any;
    expect(first.items.map((t: any) => t.id)).toEqual(['238', '239']);
    expect(first.items.map((t: any) => t.kind)).toEqual(['classic', 'scripted']);
    expect(first.nextCursor).toBe('1');
    const second = (await call(c, 'tm.testcase.list', { project: '1', limit: 2, cursor: first.nextCursor })) as any;
    expect(second.items.map((t: any) => t.id)).toEqual(['240']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('uses the project from the connector scope when the input has none', async () => {
    const r = (await call(connect(), 'tm.testcase.list', {}, { project: '2' })) as any;
    expect(r.items.map((t: any) => t.id)).toEqual(['300']);
  });

  it('reads a test case as plain text with steps, tags and custom fields, and drops embedded scripts', async () => {
    const t = (await call(connect(), 'tm.testcase.read', { id: '238' })) as any;
    expect(t).toMatchObject({ id: '238', name: 'Guest checkout with card', reference: 'TC-238', kind: 'classic', importance: 'HIGH', status: 'APPROVED' });
    expect(t.prerequisite).toBe('A product is in the basket & stock exists');
    expect(t.description).toContain('- card');
    expect(t.description).not.toMatch(/script|alert|injected/);
    expect(t.steps).toEqual([
      { action: 'Open the basket', expected: 'Basket shows 1 item' },
      { action: 'Pay by card', expected: 'Order confirmation is shown' },
      { action: 'Call test case "Log out"' },
    ]);
    expect(t.tags).toEqual(['checkout', 'payments']);
    expect(t.customFields).toEqual({ CF_TXT: 'smoke', CF_TAGS: 'checkout, payments' });
  });

  it('keeps the script of scripted test cases', async () => {
    const t = (await call(connect(), 'tm.testcase.read', { id: '239' })) as any;
    expect(t).toMatchObject({ kind: 'scripted', script: expect.stringContaining('Feature: logout') });
  });

  it('searches by name or reference by listing and filtering, and says so', async () => {
    const c = connect();
    expect(((await call(c, 'tm.testcase.search', { project: '1', query: 'checkout' })) as any).items.map((t: any) => t.id)).toEqual(['238']);
    expect(((await call(c, 'tm.testcase.search', { reference: 'tc-240' })) as any).items.map((t: any) => t.id)).toEqual(['240']);
  });

  it('caps how many items a search will scan', async () => {
    const c = connect({ config: { maxItems: 1, pageSize: 1 } });
    const r = (await call(c, 'tm.testcase.search', { query: 'Log out' })) as any;
    expect(r.items).toEqual([]);
  });

  it('reads requirements from the current version', async () => {
    const c = connect();
    expect(((await call(c, 'tm.requirement.list', { project: '1' })) as any).items).toEqual([{ id: '624', name: 'Guest can check out' }]);
    const r = (await call(c, 'tm.requirement.read', { id: '624' })) as any;
    expect(r).toMatchObject({ id: '624', reference: 'REQ-1', versionNumber: 3, criticality: 'MAJOR', category: 'CAT_FUNCTIONAL', status: 'APPROVED', verifyingTestCaseIds: ['238'], tags: ['checkout'] });
    expect(r.description).toBe('A visitor can buy without an account.');
  });

  it('reads execution history, campaigns and iterations', async () => {
    const c = connect();
    const h = (await call(c, 'tm.execution.history', { testCaseId: '238' })) as any;
    expect(h.items).toEqual([
      { id: '2', status: 'SUCCESS', executedOn: '2026-09-24T10:00:00.000Z', executedBy: 'qa.one', path: '/Retail Web/Release 12/Iteration 1', issueCount: 0 },
      { id: '5', status: 'BLOCKED', executedOn: '2026-09-25T10:00:00.000Z', executedBy: 'qa.two', path: '/Retail Web/Release 12/Iteration 2', issueCount: 2 },
    ]);
    expect(((await call(c, 'tm.campaign.list', { project: '1' })) as any).items).toEqual([{ id: '10', name: 'Release 12' }]);
    expect(((await call(c, 'tm.iteration.list', { campaign: '10' })) as any).items).toHaveLength(2);
  });

  it('maps HTTP failures to error classes', async () => {
    const c = connect();
    await expect(call(c, 'tm.testcase.read', { id: '999' })).rejects.toMatchObject({ errorClass: 'not-found' });
    await mock.close();
    mock = await startSquashMock({ token, override: () => ({ status: 503 }) });
    await expect(call(connect(), 'tm.project.list')).rejects.toMatchObject({ errorClass: 'transient' });
    await mock.close();
    mock = await startSquashMock({ token, override: () => ({ status: 200, body: '<html>login</html>', contentType: 'text/html' }) });
    await expect(call(connect(), 'tm.project.list')).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('rejects ids that are not numeric so a request path cannot be steered', async () => {
    const c = connect();
    for (const input of [{ id: '../projects' }, { id: '1?x=y' }]) await expect(call(c, 'tm.testcase.read', input)).rejects.toMatchObject({ errorClass: 'validation' });
    await expect(call(c, 'tm.testcase.list', { project: '1/../../users' })).rejects.toBeInstanceOf(PlatformError);
  });

  it('refuses capabilities Squash cannot provide', async () => {
    await expect(call(connect(), 'tm.tag.list')).rejects.toMatchObject({ errorClass: 'unsupported' });
  });

  it('stores a generated case once and finds it again by reference', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({ token: rw, permissions: 'READ_WRITE' });
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({
      egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }),
      allowedMethods: ['GET'],
      allowOther: (req) => req.method === 'POST' && /\/api\/rest\/[^/]+\/(projects\/\d+\/test-cases|test-cases\/\d+\/steps)$/.test(new URL(req.url).pathname),
    });
    const client = squashProvider.create({ baseUrl: mock.baseUrl }, { value: { token: rw }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
    const first = await call(client, 'tm.testcase.upsert', { reference: 'QAP-qa-1-1', name: 'Saved card is listed', steps: [{ action: 'Open checkout', expected: 'The card is listed' }] });
    expect(first).toEqual({ id: '1004', created: true });
    const again = await call(client, 'tm.testcase.upsert', { reference: 'QAP-qa-1-1', name: 'Saved card is listed' });
    expect(again).toEqual({ id: '1004', created: false });
    const posts = mock.nonGetRequests().filter((item) => item.method === 'POST' && item.path.includes('/test-cases') && !item.path.includes('/steps'));
    expect(posts).toHaveLength(1);
  });

  it('never sends anything but GET, whatever was called', async () => {
    const c = connect();
    await c.testConnection();
    await c.probeCapabilities();
    await call(c, 'tm.testcase.list', { project: '1' });
    await call(c, 'tm.requirement.read', { id: '624' });
    expect(mock.requests.length).toBeGreaterThan(5);
    expect(mock.nonGetRequests()).toEqual([]);
  });

  it('the hardened client refuses a write even if an adapter tried one', async () => {
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET'] });
    await expect(http.request({ method: 'POST', url: `${mock.baseUrl}/api/rest/latest/test-cases` })).rejects.toMatchObject({ errorClass: 'denied' });
    expect(mock.requests).toHaveLength(0);
  });
});

describe('htmlToText', () => {
  it('strips markup and scripts, decodes entities, keeps list structure', () => {
    expect(htmlToText('<p>a &lt;b&gt; &amp; c&#33;</p><p>d<br>e</p><style>x{}</style><ul><li>1</li><li>2</li></ul>')).toBe('a <b> & c!\nd\ne\n- 1\n- 2');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText('&#99999999999;')).toBe('&#99999999999;');
  });
});

describe('Squash through the Connector Execution Manager (read-only instance)', () => {
  function harness() {
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET'] });
    const readCaps = [...SQUASH_SUPPORTED_CAPABILITIES];
    return createHarness({
      providers: [squashProvider],
      instances: [
        makeInstance(
          { id: 'sq1', providerKey: 'squash-tm', category: 'test-management', accessMode: 'read_only', secretLocator: 'connectors/sq1/token', config: { baseUrl: mock.baseUrl }, scope: { project: '1' } },
          [...readCaps, 'tm.testcase.upsert', 'tm.execution.status.update'],
        ),
      ],
      policies: { ex1: execPolicy({ boundRoles: { testManagement: 'sq1' } }) },
      adapterDeps: { http },
    });
  }
  const actor = { type: 'step' as const, id: 'read_cases', executionId: 'ex1', stepId: 's1' };

  it('passes the provider contract kit', () => {
    expect(assertProviderContract(squashProvider)).toEqual([]);
  });

  it('reads through the manager with the leased token, audits, and never leaks the token', async () => {
    const h = harness();
    await h.secrets.put('connectors/sq1/token', { token });
    const out = await h.manager.invoke<{ items: { id: string }[] }>({ role: 'testManagement', capability: 'tm.testcase.list', input: {}, actor });
    expect(out.items.map((i) => i.id)).toEqual(['238', '239', '240']);
    expect(h.log.entries).toHaveLength(1);
    expect(h.log.entries[0]).toMatchObject({ outcome: 'ok', capability: 'tm.testcase.list', access: 'read' });
    expect(JSON.stringify(h.log.entries)).not.toContain(token);
  });

  it('denies every write capability before any request is made', async () => {
    const h = harness();
    await h.secrets.put('connectors/sq1/token', { token });
    const before = mock.requests.length;
    for (const [capability, input] of [
      ['tm.testcase.upsert', { reference: 'X-1', name: 'x' }],
      ['tm.execution.status.update', { executionId: '1', status: 'SUCCESS' }],
    ] as const) {
      await expect(h.manager.invoke({ role: 'testManagement', capability, input, idempotencyKey: 'k', actor })).rejects.toMatchObject({ errorClass: 'denied' });
    }
    expect(mock.requests.length).toBe(before);
    expect(h.log.entries.every((e) => e.outcome === 'denied')).toBe(true);
  });
});
