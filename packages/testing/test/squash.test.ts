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

/** Worker-aligned egress: test-case store plus iteration execution create and status PATCH. */
function squashTestCaseWrites(req: { method: string; url: string }): boolean {
  const path = new URL(req.url).pathname;
  if (req.method === 'POST' && /\/api\/rest\/[^/]+\/(test-cases(\/\d+\/steps)?|iterations\/\d+\/executions)$/.test(path)) return true;
  if (req.method === 'DELETE' && /\/api\/rest\/[^/]+\/test-steps\/\d+$/.test(path)) return true;
  return req.method === 'PATCH' && /\/api\/rest\/[^/]+\/(test-cases|executions)\/\d+$/.test(path);
}

beforeEach(async () => {
  mock = await startSquashMock({ token, permissions: 'READ' });
});
afterEach(async () => {
  await mock.close();
});

describe('Squash provider against the documentation-based mock', () => {
  it('declares only capabilities that exist in the catalog and that Squash documents', () => {
    expect(squashProvider.manifest.capabilities).toEqual([...SQUASH_SUPPORTED_CAPABILITIES]);
    expect(squashProvider.manifest.capabilities.filter((id) => caps.get(id).access === 'write')).toEqual([
      'tm.testcase.upsert',
      'tm.execution.upsert',
      'tm.execution.status.update',
    ]);
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

  it('turns a wrong token into a clear auth error with a Squash body snippet, and never echoes the token', async () => {
    const badToken = 'x'.repeat(30);
    const bad = connect({ token: badToken });
    const r = await bad.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the API token/);
    expect(r.message).toMatch(/Squash said:.*Unauthorized/);
    expect(r.message).not.toContain(badToken);
    await expect(call(bad, 'tm.project.list')).rejects.toMatchObject({
      errorClass: 'auth',
      message: expect.stringMatching(/Squash said:.*Unauthorized/),
    });
  });

  it('rejects a blank or whitespace-only token on save and on lease', () => {
    expect(() => squashProvider.secretSchema.parse({ token: ' \n\t ' })).toThrow();
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET'] });
    expect(() =>
      squashProvider.create({ baseUrl: mock.baseUrl }, { value: { token: '   ' }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http }),
    ).toThrow(/token|API token/i);
  });

  it('fails fast when a password is present but the API token is missing', () => {
    expect(() => squashProvider.secretSchema.parse({ password: 'not-a-token', username: 'qa' })).toThrow(/personal API token|Bearer|username\/password/i);
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET'] });
    expect(() =>
      squashProvider.create(
        { baseUrl: mock.baseUrl },
        { value: { password: 'login-password-value', username: 'squash-user' }, expiresAt: new Date(Date.now() + 60_000), release() {} },
        { http },
      ),
    ).toThrow(/personal API token|Bearer|username\/password/i);
  });

  it('ignores username/password when a token is present and never sends Basic on upsert', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({ token: rw, permissions: 'READ_WRITE' });
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({
      egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }),
      allowedMethods: ['GET'],
      allowOther: squashTestCaseWrites,
    });
    const client = squashProvider.create(
      { baseUrl: `http://user:pass@127.0.0.1:${new URL(mock.baseUrl).port}${new URL(mock.baseUrl).pathname}` },
      {
        value: { token: rw, username: 'ignored-user', password: 'ignored-password' },
        expiresAt: new Date(Date.now() + 60_000),
        release() {},
      },
      { http },
    );
    await call(client, 'tm.testcase.upsert', { reference: 'QAP-no-basic-1', name: 'No Basic', steps: [{ action: 'Open', expected: 'Ok' }] });
    const posts = mock.nonGetRequests().filter((item) => item.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((item) => item.authorization === `Bearer ${rw}`)).toBe(true);
    expect(posts.every((item) => !String(item.authorization ?? '').startsWith('Basic '))).toBe(true);
    expect(mock.requests.every((item) => !String(item.authorization ?? '').startsWith('Basic '))).toBe(true);
  });

  it('probes capabilities from real endpoints and declares what Squash does not offer', async () => {
    const probe = await connect().probeCapabilities();
    const by = Object.fromEntries(probe.map((p) => [p.capability, p]));
    expect(by['tm.testcase.list']!.support).toBe('supported');
    expect(by['tm.requirement.read']!.support).toBe('supported');
    expect(by['tm.testcase.search']).toMatchObject({ support: 'partial' });
    expect(by['tm.testcase.upsert']).toMatchObject({ support: 'partial', reason: expect.stringMatching(/READ_WRITE/) });
    expect(by['tm.execution.upsert']).toMatchObject({ support: 'partial', reason: expect.stringMatching(/READ_WRITE/) });
    expect(by['tm.execution.status.update']).toMatchObject({ support: 'partial', reason: expect.stringMatching(/READ_WRITE/) });
    for (const id of ['tm.tag.list', 'tm.customfield.list', 'tm.suite.list']) expect(by[id]!.support).toBe('unsupported');
    expect(mock.nonGetRequests()).toEqual([]);
  });

  it('marks test-case and execution writes supported when the token is READ_WRITE', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({ token: rw, permissions: 'READ_WRITE' });
    const probe = await connect({ token: rw }).probeCapabilities();
    expect(probe.find((p) => p.capability === 'tm.testcase.upsert')).toMatchObject({ support: 'supported' });
    expect(probe.find((p) => p.capability === 'tm.execution.upsert')).toMatchObject({
      support: 'supported',
      reason: expect.stringMatching(/POST \/iterations\/\{id\}\/executions/),
    });
    expect(probe.find((p) => p.capability === 'tm.execution.status.update')).toMatchObject({
      support: 'supported',
      reason: expect.stringMatching(/PATCH \/executions\/\{id\}/),
    });
  });

  it('still advertises execution upsert when the global iteration list is refused', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({
      token: rw,
      permissions: 'READ_WRITE',
      override: (r) => (r.path.split('?')[0] === '/squash/api/rest/latest/iterations' ? { status: 403 } : undefined),
    });
    const probe = await connect({ token: rw }).probeCapabilities();
    expect(probe.find((p) => p.capability === 'tm.iteration.list')).toMatchObject({ support: 'unsupported' });
    expect(probe.find((p) => p.capability === 'tm.execution.upsert')).toMatchObject({ support: 'supported' });
    expect(probe.find((p) => p.capability === 'tm.execution.status.update')).toMatchObject({ support: 'supported' });
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

  it('resolves a configured project name via GET /projects before listing', async () => {
    const r = (await call(connect({ config: { projectName: 'Back Office' } }), 'tm.testcase.list')) as any;
    expect(r.items.map((t: any) => t.id)).toEqual(['300']);
    expect(mock.requests.some((req) => req.method === 'GET' && req.path.includes('/projects'))).toBe(true);
  });

  it('accepts a legacy project id config field as projectId', async () => {
    const r = (await call(connect({ config: { project: '2' } }), 'tm.testcase.list')) as any;
    expect(r.items.map((t: any) => t.id)).toEqual(['300']);
  });

  it('reports a clear error when the project name is missing or ambiguous', async () => {
    await expect(call(connect({ config: { projectName: 'Missing Project' } }), 'tm.testcase.list')).rejects.toMatchObject({
      errorClass: 'validation',
      message: expect.stringContaining('No Squash project named "Missing Project"'),
    });
    await mock.close();
    mock = await startSquashMock({
      token,
      projects: [
        { id: 10, name: 'ToolKit-AgenFlow' },
        { id: 11, name: 'ToolKit-AgenFlow' },
      ],
    });
    await expect(call(connect({ config: { projectName: 'ToolKit-AgenFlow' } }), 'tm.testcase.list')).rejects.toMatchObject({
      errorClass: 'validation',
      message: expect.stringMatching(/Several Squash projects are named "ToolKit-AgenFlow".*10.*11/),
    });
  });

  it('tests connection against a project name and surfaces the resolved id', async () => {
    await mock.close();
    mock = await startSquashMock({ token, projects: [{ id: 7, name: 'ToolKit-AgenFlow' }, { id: 2, name: 'Back Office' }] });
    const r = await connect({ config: { projectName: 'ToolKit-AgenFlow' } }).testConnection();
    expect(r).toMatchObject({ ok: true, discovered: { projectId: '7', projectName: 'ToolKit-AgenFlow' } });
    const missing = await connect({ config: { projectName: 'No Such' } }).testConnection();
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining('No Squash project named "No Such"') });
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

  it('stores a generated case once and PATCHes it again by automated_test_reference', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({ token: rw, permissions: 'READ_WRITE' });
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({
      egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }),
      allowedMethods: ['GET'],
      allowOther: squashTestCaseWrites,
    });
    // Lease with surrounding whitespace — must still send Authorization: Bearer <trimmed token>.
    const client = squashProvider.create({ baseUrl: mock.baseUrl }, { value: { token: `  ${rw}\n` }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
    const first = await call(client, 'tm.testcase.upsert', {
      reference: 'QAP-qa-1-1',
      name: 'Saved card is listed',
      description: '<p>Kind: positive · Priority: medium</p><p>Expected: The card is listed</p>',
      steps: [{ action: 'Open checkout', expected: 'The card is listed' }],
    });
    expect(first).toEqual({ id: '1004', created: true, projectId: '1' });
    const again = await call(client, 'tm.testcase.upsert', {
      reference: 'QAP-qa-1-1',
      name: 'Saved card is listed (updated)',
      description: '<p>Kind: positive · Priority: medium</p><p>Expected: Card still listed</p>',
      steps: [{ action: 'Re-open checkout', expected: 'Card still listed' }],
    });
    expect(again).toEqual({ id: '1004', created: false, projectId: '1' });
    const patches = mock.nonGetRequests().filter((item) => item.method === 'PATCH' && /\/test-cases\/\d+/.test(item.path));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.path).toMatch(/\/api\/rest\/[^/]+\/test-cases\/1004$/);
    expect(patches[0]!.body).toEqual({
      _type: 'test-case',
      name: 'Saved card is listed (updated)',
      automated_test_reference: 'QAP-qa-1-1',
      description: '<p>Kind: positive · Priority: medium</p><p>Expected: Card still listed</p>',
    });
    expect(patches[0]!.authorization).toBe(`Bearer ${rw}`);
    expect(patches[0]!.body).not.toHaveProperty('parent');
    const deletes = mock.nonGetRequests().filter((item) => item.method === 'DELETE' && /\/test-steps\/\d+/.test(item.path));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    const stepPosts = mock.nonGetRequests().filter((item) => item.method === 'POST' && /\/test-cases\/\d+\/steps$/.test(item.path));
    expect(stepPosts.some((item) => (item.body as { action?: string })?.action?.includes('Re-open checkout'))).toBe(true);
    const pinned = await call(client, 'tm.testcase.upsert', { project: '2', reference: 'QAP-qa-1-2', name: 'Pinned project case', steps: [{ action: 'Open', expected: 'Ok' }] });
    expect(pinned).toEqual({ id: '1005', created: true, projectId: '2' });
    const byName = squashProvider.create(
      { baseUrl: mock.baseUrl, projectName: 'Back Office' },
      { value: { token: rw }, expiresAt: new Date(Date.now() + 60_000), release() {} },
      { http },
    );
    const named = await call(byName, 'tm.testcase.upsert', { reference: 'QAP-qa-1-3', name: 'Named project case', steps: [{ action: 'Open', expected: 'Ok' }] });
    expect(named).toEqual({ id: '1006', created: true, projectId: '2' });
    const posts = mock.nonGetRequests().filter((item) => item.method === 'POST' && /\/test-cases(\?|$)/.test(item.path) && !item.path.includes('/steps'));
    expect(posts).toHaveLength(3);
    expect(posts.every((item) => /\/api\/rest\/[^/]+\/test-cases$/.test(item.path))).toBe(true);
    expect(posts.every((item) => !item.path.includes('/projects/'))).toBe(true);
    expect(posts.map((item) => item.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _type: 'test-case',
        name: 'Saved card is listed',
        parent: { _type: 'project', id: 1 },
        automated_test_reference: 'QAP-qa-1-1',
        description: '<p>Kind: positive · Priority: medium</p><p>Expected: The card is listed</p>',
      }),
      expect.objectContaining({
        _type: 'test-case',
        name: 'Pinned project case',
        parent: { _type: 'project', id: 2 },
        automated_test_reference: 'QAP-qa-1-2',
      }),
      expect.objectContaining({
        _type: 'test-case',
        name: 'Named project case',
        parent: { _type: 'project', id: 2 },
        automated_test_reference: 'QAP-qa-1-3',
      }),
    ]));
    // Upsert POST/PATCH must use Bearer only (same header as GET) — never Token, Basic, or bare token.
    expect(posts.every((item) => item.authorization === `Bearer ${rw}`)).toBe(true);
    expect(posts.every((item) => !String(item.authorization ?? '').startsWith('Basic '))).toBe(true);
    expect(mock.requests.filter((item) => item.method === 'GET').every((item) => item.authorization === `Bearer ${rw}`)).toBe(true);
  });

  it('creates an iteration execution and PATCHes its status with a READ_WRITE token', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({ token: rw, permissions: 'READ_WRITE' });
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({
      egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }),
      allowedMethods: ['GET'],
      allowOther: squashTestCaseWrites,
    });
    const client = squashProvider.create({ baseUrl: mock.baseUrl }, { value: { token: rw }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
    const created = (await call(client, 'tm.execution.upsert', { testCaseId: '238' })) as { id: string; created: boolean };
    expect(created).toMatchObject({ created: true, id: expect.stringMatching(/^\d+$/) });
    const posts = mock.nonGetRequests().filter((item) => item.method === 'POST' && /\/iterations\/\d+\/executions$/.test(item.path));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      _type: 'execution',
      test_case: { _type: 'test-case', id: 238 },
      execution_status: 'READY',
    });
    expect(posts[0]!.authorization).toBe(`Bearer ${rw}`);
    await expect(call(client, 'tm.execution.status.update', { executionId: created.id, status: 'SUCCESS', actualResult: 'Passed' })).resolves.toEqual({ ok: true });
    const patches = mock.nonGetRequests().filter((item) => item.method === 'PATCH' && /\/executions\/\d+$/.test(item.path));
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toMatchObject({ _type: 'execution', execution_status: 'SUCCESS' });
    expect(patches[0]!.authorization).toBe(`Bearer ${rw}`);
  });

  it('finds an iteration via a campaign when the global iteration list is refused', async () => {
    const rw = makeSquashToken({ permissions: 'READ_WRITE' });
    await mock.close();
    mock = await startSquashMock({
      token: rw,
      permissions: 'READ_WRITE',
      override: (r) => (r.path.split('?')[0] === '/squash/api/rest/latest/iterations' ? { status: 403 } : undefined),
    });
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({
      egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }),
      allowedMethods: ['GET'],
      allowOther: squashTestCaseWrites,
    });
    const client = squashProvider.create({ baseUrl: mock.baseUrl }, { value: { token: rw }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
    const created = (await call(client, 'tm.execution.upsert', { testCaseId: '238' })) as { id: string; created: boolean };
    expect(created).toMatchObject({ created: true, id: expect.stringMatching(/^\d+$/) });
    expect(mock.requests.some((item) => item.method === 'GET' && /\/campaigns\/\d+\/iterations/.test(item.path))).toBe(true);
  });

  it('explains that a READ token can Test Connection but not store cases (Squash answers 401 on write)', async () => {
    const read = makeSquashToken({ permissions: 'READ' });
    await mock.close();
    mock = await startSquashMock({ token: read, permissions: 'READ' });
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({
      egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }),
      allowedMethods: ['GET'],
      allowOther: squashTestCaseWrites,
    });
    const client = squashProvider.create({ baseUrl: mock.baseUrl }, { value: { token: read }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
    expect((await client.testConnection()).ok).toBe(true);
    await expect(call(client, 'tm.testcase.upsert', { reference: 'QAP-read-1', name: 'Should fail' })).rejects.toMatchObject({
      errorClass: 'auth',
      message: expect.stringMatching(/READ-only|READ_WRITE/),
    });
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
      ['tm.execution.upsert', { testCaseId: '238' }],
      ['tm.execution.status.update', { executionId: '1', status: 'SUCCESS' }],
    ] as const) {
      await expect(h.manager.invoke({ role: 'testManagement', capability, input, idempotencyKey: 'k', actor })).rejects.toMatchObject({ errorClass: 'denied' });
    }
    expect(mock.requests.length).toBe(before);
    expect(h.log.entries.every((e) => e.outcome === 'denied')).toBe(true);
  });
});
