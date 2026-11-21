import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { EgressPolicy, HardenedHttpClient, acceptanceCriteriaFromDescription, adfToText, azureBoardsProvider, azureDevOpsProvider, azureFieldString, azureWorkItemFields, githubProvider, githubWriteScopes, azureDevOpsWriteScopes, jiraProvider, playwrightMcpProvider, scenarioCuesFromDescription, splitAcceptanceCriteria } from '@qa/infrastructure';
import { assertProviderContract } from '../src';

const TOKEN = 'readonly-token-value-0001';
const lease = { value: { token: TOKEN }, expiresAt: new Date(Date.now() + 60_000), release() {} };

interface Hit { method: string; path: string; auth?: string; body?: string; accept?: string; session?: string }

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

async function mock(handle: (hit: Hit) => { status?: number; headers?: Record<string, string>; body: unknown; raw?: string }) {
  const hits: Hit[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const hit: Hit = { method: req.method ?? 'GET', path: req.url ?? '/', auth: req.headers.authorization, accept: req.headers.accept, session: req.headers['mcp-session-id'] as string | undefined, body: Buffer.concat(chunks).toString() };
    hits.push(hit);
    const out = handle(hit);
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(out.raw ?? JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  closeServer = () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  const http = new HardenedHttpClient({
    egress: new EgressPolicy({ rules: [{ hostPattern: '127.0.0.1', purpose: 'connector', internal: true, allowHttp: true, allowLoopback: true }], profile: 'standard', platformEnv: 'development' }),
    allowedMethods: ['GET', 'HEAD'],
    allowOther: (req) => req.method === 'POST' && /\/(_apis\/wit\/wiql|mcp)$/.test(new URL(req.url).pathname),
  });
  return { baseUrl: `http://127.0.0.1:${port}`, hits, http };
}

const pathOf = (hit: Hit) => new URL(hit.path, 'http://mock').pathname;

describe('source and work-item providers', () => {
  it('passes the provider contract and keeps source repositories free of write capabilities', () => {
    for (const p of [githubProvider, azureDevOpsProvider, jiraProvider, azureBoardsProvider, playwrightMcpProvider]) expect(assertProviderContract(p), p.manifest.providerKey).toEqual([]);
    expect(githubProvider.manifest.verification).toBe('live-capable');
    expect(azureDevOpsProvider.manifest.verification).toBe('fixtures-only');
    expect(jiraProvider.manifest.verification).toBe('fixtures-only');
    expect(githubWriteScopes('read:org, repo, workflow')).toEqual(['repo', 'workflow']);
    expect(githubWriteScopes('read:org, read:user')).toEqual([]);
    expect(azureDevOpsWriteScopes('vso.code vso.code_write')).toEqual(['vso.code_write']);
  });

  it('reads GitHub and refuses a token that can push', async () => {
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path === '/user') return { headers: { 'x-oauth-scopes': 'read:org' }, body: { login: 'ada' } };
      if (path === '/user/orgs') return { body: [{ id: 1, login: 'acme' }] };
      if (path === '/orgs/acme/repos') return { body: [{ id: 9, name: 'shop' }] };
      if (path === '/repos/acme/shop' && !path.includes('contents')) return { body: { permissions: { pull: true, push: false, admin: false } } };
      if (path.endsWith('/branches')) return { body: [{ name: 'main' }] };
      if (path.endsWith('/contents/')) return { body: [{ path: 'README.md', type: 'file', size: 5 }] };
      if (path.endsWith('/contents/README.md')) return { body: { path: 'README.md', encoding: 'base64', content: Buffer.from('hello').toString('base64') } };
      if (path.endsWith('/commits')) return { body: [{ sha: 'abc', commit: { message: 'init', author: { name: 'Ada' } } }] };
      if (path === '/search/code') return { body: { items: [{ path: 'src/a.ts', text_matches: [{ fragment: 'login()' }] }] } };
      return { status: 404, body: {} };
    });
    const client = githubProvider.create({ baseUrl: m.baseUrl, org: 'acme', repo: 'shop' }, lease, { http: m.http });
    expect((await client.testConnection()).message).toBe('Connected to GitHub.');
    expect((await client.inspectPermissions()).writePermissionsDetected).toEqual([]);
    expect(await client.handle({ id: 'scm.file.read' } as never, { path: 'README.md' }, {} as never)).toMatchObject({ content: 'hello', truncated: false });
    expect(await client.handle({ id: 'scm.code.search' } as never, { query: 'login', repo: 'shop' }, {} as never)).toMatchObject({ items: [{ path: 'src/a.ts', snippet: 'login()' }] });
    expect(m.hits.every((h) => h.method === 'GET')).toBe(true);
    expect(JSON.stringify(m.hits.map((h) => h.body ?? ''))).not.toContain(TOKEN);
    await client.dispose();

    const writable = await mock((hit) => (pathOf(hit) === '/user' ? { headers: { 'x-oauth-scopes': 'repo' }, body: { login: 'ada' } } : { body: { permissions: { push: true } } }));
    const bad = githubProvider.create({ baseUrl: writable.baseUrl, org: 'acme', repo: 'shop' }, lease, { http: writable.http });
    expect((await bad.testConnection()).message).toMatch(/read-only token/);
    expect((await bad.inspectPermissions()).writePermissionsDetected).toEqual(expect.arrayContaining(['repo', 'repository.push']));
    await bad.dispose();

    const owner = await mock(() => ({ body: { login: 'ada', permissions: { admin: true, push: true, pull: true } } }));
    const readOnlyOwner = githubProvider.create({ baseUrl: owner.baseUrl, org: 'acme', repo: 'shop' }, lease, { http: owner.http });
    expect((await readOnlyOwner.inspectPermissions()).writePermissionsDetected).toEqual([]);
    expect((await readOnlyOwner.testConnection()).message).toBe('Connected to GitHub.');
    await readOnlyOwner.dispose();
  });

  it('reads Azure DevOps from recorded responses and reports an unscoped token plainly', async () => {
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/connectionData')) return { body: { authenticatedUser: { providerDisplayName: 'Ada' } } };
      if (path.endsWith('/repositories')) return { body: { value: [{ id: 'r1', name: 'shop' }] } };
      if (path.endsWith('/refs')) return { body: { value: [{ name: 'refs/heads/main' }] } };
      if (path.endsWith('/commits')) return { body: { value: [{ commitId: 'abc', comment: 'init', author: { name: 'Ada' } }] } };
      if (path.endsWith('/items')) return { body: { value: [{ path: '/README.md', gitObjectType: 'blob' }], content: 'hello' } };
      return { status: 404, body: {} };
    });
    const client = azureDevOpsProvider.create({ baseUrl: `${m.baseUrl}/myorg`, project: 'Web', repo: 'shop' }, lease, { http: m.http });
    const conn = await client.testConnection();
    expect(conn.ok).toBe(true);
    expect(conn.message).toMatch(/did not report token scopes/);
    expect(m.hits[0]?.path).toContain('api-version=7.1-preview.1');
    expect(m.hits[1]?.path).toContain('api-version=7.1');
    expect(m.hits[1]?.path).not.toContain('preview');
    expect((await client.inspectPermissions()).writePermissionsDetected).toEqual([]);
    expect(await client.handle({ id: 'scm.branch.list' } as never, {}, {} as never)).toMatchObject({ items: [{ name: 'main' }] });
    expect(await client.handle({ id: 'scm.code.search' } as never, { query: 'readme' }, {} as never)).toMatchObject({
      items: [{ path: 'README.md', snippet: 'README.md' }],
    });
    expect(m.hits.every((h) => h.method === 'GET')).toBe(true);
  });

  it('names the repositories when the configured Azure DevOps repository is missing', async () => {
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/connectionData')) return { body: { authenticatedUser: { providerDisplayName: 'Ada' } } };
      if (path.endsWith('/repositories')) return { body: { value: [{ id: 'r1', name: 'shop' }] } };
      return { status: 404, body: {} };
    });
    const client = azureDevOpsProvider.create({ baseUrl: `${m.baseUrl}/myorg`, project: 'Web', repo: 'missing' }, lease, { http: m.http });
    const conn = await client.testConnection();
    expect(conn.ok).toBe(false);
    expect(conn.message).toMatch(/missing/);
    expect(conn.message).toMatch(/shop/);
  });

  it('splits acceptance criteria and scenario cues from plain text', () => {
    expect(splitAcceptanceCriteria('- Card listed\n- Tax included')).toEqual(['Card listed', 'Tax included']);
    expect(splitAcceptanceCriteria('Given a card\nWhen paying\nThen receipt shows')).toEqual(['Given a card When paying Then receipt shows']);
    expect(scenarioCuesFromDescription('Intro only')).toEqual([]);
    expect(scenarioCuesFromDescription('Notes\n- First check\n- Second check')).toEqual(['First check', 'Second check']);
  });

  it('reads Jira acceptance criteria from the description', async () => {
    const description = { type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'Acceptance criteria' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'The saved card is listed' }] }] };
    expect(acceptanceCriteriaFromDescription(`Intro\n\n## Acceptance criteria\nThe saved card is listed\n\n## Notes\nignore`)).toBe('The saved card is listed');
    expect(adfToText(description)).toMatch(/Acceptance criteria/);
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/myself')) return { body: { displayName: 'Ada' } };
      if (path.endsWith('/project/search')) return { body: { values: [{ id: '100', name: 'Shop' }] } };
      if (path.endsWith('/search/jql')) return { body: { issues: [{ key: 'SHOP-1', fields: { summary: 'Checkout', status: { name: 'Open' }, issuetype: { name: 'Story' } } }] } };
      if (path.endsWith('/issue/SHOP-1')) return { body: { key: 'SHOP-1', fields: { summary: 'Checkout', description, status: { name: 'Open' }, issuetype: { name: 'Story' } } } };
      return { status: 404, body: {} };
    });
    const client = jiraProvider.create({ baseUrl: m.baseUrl, email: 'ada@example.com' }, lease, { http: m.http });
    expect((await client.testConnection()).ok).toBe(true);
    const item = await client.handle({ id: 'workitem.read' } as never, { id: 'SHOP-1' }, {} as never);
    expect(item).toMatchObject({ id: 'SHOP-1', title: 'Checkout', acceptanceCriteria: 'The saved card is listed' });
    expect(m.hits[0]!.auth?.startsWith('Basic ')).toBe(true);
    expect(JSON.stringify(m.hits)).not.toContain(TOKEN);
  });

  it('reads a Jira attachment with the same credential', async () => {
    let base = '';
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/issue/SHOP-1')) return { body: { fields: { attachment: [{ id: '10001', filename: 'spec.txt', mimeType: 'text/plain', size: 5, content: `${base}/rest/api/3/attachment/content/10001` }] } } };
      if (path.endsWith('/attachment/content/10001')) return { raw: 'hello', body: {} };
      return { status: 404, body: {} };
    });
    base = m.baseUrl;
    const client = jiraProvider.create({ baseUrl: m.baseUrl, email: 'ada@example.com' }, lease, { http: m.http });
    const file = await client.handle({ id: 'workitem.attachment.read' } as never, { workItemId: 'SHOP-1', attachmentId: '10001' }, {} as never);
    expect(file).toMatchObject({ name: 'spec.txt', mimeType: 'text/plain', contentBase64: Buffer.from('hello').toString('base64') });
  });

  it('reads Azure Boards acceptance criteria from the field', async () => {
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (hit.method === 'POST' && path.endsWith('/_apis/wit/wiql')) return { body: { workItems: [{ id: 12 }] } };
      if (path.endsWith('/workitems/12')) return { body: { id: 12, fields: { 'System.Title': 'Checkout', 'System.State': 'New', 'System.WorkItemType': 'User Story', 'System.Description': '<p>Pay</p>', 'Microsoft.VSTS.Common.AcceptanceCriteria': 'The saved card is listed' } } };
      if (path.endsWith('/workitems')) return { body: { value: [{ id: 12, fields: { 'System.Title': 'Checkout', 'System.State': 'New', 'System.WorkItemType': 'User Story' } }] } };
      if (path.endsWith('/projects')) return { body: { count: 1, value: [{ id: 'p', name: 'Web' }] } };
      return { status: 404, body: {} };
    });
    const client = azureBoardsProvider.create({ organization: 'contoso', project: 'Web', baseUrl: m.baseUrl }, lease, { http: m.http });
    expect((await client.testConnection()).ok).toBe(true);
    expect(await client.handle({ id: 'workitem.read' } as never, { id: '12' }, {} as never)).toMatchObject({ title: 'Checkout', acceptanceCriteria: 'The saved card is listed', description: 'Pay' });
    expect(await client.handle({ id: 'workitem.search' } as never, { query: 'Checkout' }, {} as never)).toMatchObject({ items: [{ id: '12', title: 'Checkout' }] });
    expect(m.hits.some((h) => h.method === 'POST' && h.path.includes('wiql'))).toBe(true);
    const readHit = m.hits.find((h) => h.method === 'GET' && pathOf(h).endsWith('/workitems/12'));
    expect(readHit?.path).toMatch(/fields=.*System\.Title/);
  });

  it('reads System.Title from nested fields.fields and value wrappers', async () => {
    const nested = {
      id: 3421,
      fields: {
        fields: {
          'System.Title': { value: 'Order transactions calculation flow update to match new payment settlement and reasons' },
          'System.State': 'Active',
          'System.WorkItemType': 'User Story',
          'System.Description': '<p>Settle ledger rows with the new payment reasons.</p>',
        },
      },
    };
    const flat = azureWorkItemFields(nested);
    expect(azureFieldString(flat, 'System.Title')).toMatch(/Order transactions calculation flow/);
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/workitems/3421')) return { body: nested };
      return { status: 404, body: {} };
    });
    const client = azureBoardsProvider.create({ organization: 'contoso', project: 'PayNSure', baseUrl: m.baseUrl }, lease, { http: m.http });
    expect(await client.handle({ id: 'workitem.read' } as never, { id: '3421' }, {} as never)).toMatchObject({
      title: 'Order transactions calculation flow update to match new payment settlement and reasons',
      description: 'Settle ledger rows with the new payment reasons.',
    });
  });

  it('reads Azure Boards acceptance criteria from Description HTML when the field is empty', async () => {
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/workitems/7189')) {
        return {
          body: {
            id: 7189,
            fields: {
              'System.Title': 'PayNSure checkout',
              'System.State': 'Active',
              'System.WorkItemType': 'User Story',
              'System.Description': '<div><b>Acceptance Criteria</b></div><ul><li>The saved card is listed</li><li>The total includes tax</li></ul><p>Given a saved card</p><p>When the shopper pays</p><p>Then the receipt shows the card</p>',
            },
          },
        };
      }
      return { status: 404, body: {} };
    });
    const client = azureBoardsProvider.create({ organization: 'contoso', project: 'PayNSure', baseUrl: m.baseUrl }, lease, { http: m.http });
    const item = await client.handle({ id: 'workitem.read' } as never, { id: '7189' }, {} as never) as { description?: string; acceptanceCriteria?: string };
    expect(item.description).toMatch(/Acceptance Criteria/);
    expect(item.description).toMatch(/The saved card is listed/);
    expect(item.acceptanceCriteria).toMatch(/The saved card is listed/);
    expect(item.acceptanceCriteria).toMatch(/The total includes tax/);
  });

  it('reads an Azure Boards attachment with the same credential', async () => {
    let base = '';
    const m = await mock((hit) => {
      const path = pathOf(hit);
      if (path.endsWith('/workitems/12')) return { body: { relations: [{ rel: 'AttachedFile', url: `${base}/attach/abc`, attributes: { name: 'spec.txt' } }] } };
      if (path.endsWith('/attach/abc')) return { raw: 'hello', body: {} };
      return { status: 404, body: {} };
    });
    base = m.baseUrl;
    const client = azureBoardsProvider.create({ organization: 'contoso', project: 'Web', baseUrl: m.baseUrl }, lease, { http: m.http });
    const file = await client.handle({ id: 'workitem.attachment.read' } as never, { workItemId: '12', attachmentId: 'abc' }, {} as never);
    expect(file).toMatchObject({ name: 'spec.txt', contentBase64: Buffer.from('hello').toString('base64') });
  });

  it('talks to the managed Playwright server and refuses an unlisted origin', async () => {
    const m = await mock((hit) => {
      const body = JSON.parse(hit.body || '{}') as { method?: string; params?: { name?: string; arguments?: { url?: string } } };
      if (body.method === 'initialize') return { body: { result: { serverInfo: { name: 'playwright', version: '1.2.3' } } } };
      if (body.method === 'tools/list') return { body: { result: { tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_select_option', 'browser_press_key', 'browser_take_screenshot', 'browser_network_requests', 'browser_close'].map((name) => ({ name })) } } };
      if (body.params?.name === 'browser_snapshot') return { body: { result: { content: [{ text: 'button Checkout' }], url: 'https://shop.example.com/cart' } } };
      if (body.params?.name === 'browser_navigate') return { body: { result: { content: [] } } };
      return { body: { result: { content: [{ data: 'aW1n' }], requests: [] } } };
    });
    const client = playwrightMcpProvider.create({ baseUrl: m.baseUrl, allowedOrigins: 'https://shop.example.com', savedSessionName: 'ada-signed-in' }, undefined, { http: m.http });
    const conn = await client.testConnection();
    expect(conn.ok).toBe(true);
    expect(conn.message).toMatch(/ada-signed-in/);
    expect(m.hits[0]?.accept).toContain('text/event-stream');
    const probes = await client.probeCapabilities();
    expect(probes.find((p) => p.capability === 'browser.navigate')).toMatchObject({ support: 'supported' });
    const opened = await client.handle({ id: 'browser.session.open' } as never, {}, {} as never) as { sessionId: string };
    expect(opened.sessionId).toBeTruthy();
    expect(await client.handle({ id: 'browser.navigate' } as never, { sessionId: opened.sessionId, url: 'https://shop.example.com/cart' }, {} as never)).toMatchObject({ finalUrl: 'https://shop.example.com/cart' });
    await expect(client.handle({ id: 'browser.navigate' } as never, { sessionId: opened.sessionId, url: 'https://evil.example/phish' }, {} as never)).rejects.toMatchObject({ errorClass: 'denied' });
    expect(await client.handle({ id: 'browser.snapshot' } as never, { sessionId: opened.sessionId }, {} as never)).toMatchObject({ accessibilityTree: 'button Checkout' });
  });

  it('accepts a bare host in Playwright allowedOrigins (URL vs host)', async () => {
    const m = await mock((hit) => {
      const body = JSON.parse(hit.body || '{}') as { method?: string };
      if (body.method === 'initialize') return { body: { result: { serverInfo: { name: 'playwright', version: '1.2.3' } } } };
      return { body: { result: { content: [] } } };
    });
    const client = playwrightMcpProvider.create({ baseUrl: m.baseUrl, allowedOrigins: 'sdk.paynsure.internal' }, undefined, { http: m.http });
    const opened = await client.handle({ id: 'browser.session.open' } as never, {}, {} as never) as { sessionId: string };
    await expect(client.handle({ id: 'browser.navigate' } as never, { sessionId: opened.sessionId, url: 'https://sdk.paynsure.internal/app' }, {} as never)).resolves.toMatchObject({
      finalUrl: 'https://sdk.paynsure.internal/app',
    });
  });

  it('explains a Playwright 403 as a host-name refusal', async () => {
    const m = await mock(() => ({ status: 403, body: { error: 'forbidden' } }));
    const client = playwrightMcpProvider.create({ baseUrl: m.baseUrl, allowedOrigins: 'https://shop.example.com' }, undefined, { http: m.http });
    expect((await client.testConnection()).message).toMatch(/playwright-mcp/);
  });

  it('explains an unreachable Playwright server with the Compose browser profile address', async () => {
    const { PlatformError } = await import('@qa/domain');
    const http = {
      request: async () => {
        throw new PlatformError('transient', 'could not resolve playwright-mcp');
      },
    };
    const client = playwrightMcpProvider.create({ baseUrl: 'http://playwright-mcp:8931', allowedOrigins: 'https://shop.example.com' }, undefined, { http });
    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/profile "browser"/);
    expect(result.message).toMatch(/http:\/\/playwright-mcp:8931/);
  });

  it('reads a Playwright event-stream reply', async () => {
    const m = await mock((hit) => {
      const body = JSON.parse(hit.body || '{}') as { method?: string };
      if (body.method === 'initialize') {
        return { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' }, raw: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"playwright","version":"1.55"}}}\n\n', body: {} };
      }
      return { status: 202, body: {} };
    });
    const client = playwrightMcpProvider.create({ baseUrl: m.baseUrl, allowedOrigins: 'https://shop.example.com' }, undefined, { http: m.http });
    const conn = await client.testConnection();
    expect(conn.ok).toBe(true);
    expect(conn.discovered).toMatchObject({ server: 'playwright', version: '1.55' });
    expect(m.hits[1]?.body).toContain('notifications/initialized');
    expect(m.hits[1]?.session).toBe('sess-1');
  });
});

const liveGithub = process.env.GITHUB_LIVE_TOKEN && process.env.GITHUB_LIVE_ORG ? describe : describe.skip;
liveGithub('GitHub live (opt in)', () => {
  it('connects with the supplied read-only token', async () => {
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules: [{ hostPattern: 'api.github.com', purpose: 'connector', internal: false, allowHttp: false }], profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET', 'HEAD'] });
    const client = githubProvider.create({ baseUrl: process.env.GITHUB_LIVE_API ?? 'https://api.github.com', org: process.env.GITHUB_LIVE_ORG!, repo: process.env.GITHUB_LIVE_REPO }, { value: { token: process.env.GITHUB_LIVE_TOKEN! }, expiresAt: new Date(Date.now() + 60_000), release() {} }, { http });
    const result = await client.testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).not.toMatch(/can change the repository/);
  });
});

const liveBoards = process.env.AZURE_BOARDS_LIVE_TOKEN && process.env.AZURE_BOARDS_LIVE_ORG && process.env.AZURE_BOARDS_LIVE_PROJECT ? describe : describe.skip;
liveBoards('Azure Boards live (opt in)', () => {
  it('connects with the supplied token', async () => {
    const org = process.env.AZURE_BOARDS_LIVE_ORG!;
    const base = process.env.AZURE_BOARDS_LIVE_API ?? `https://dev.azure.com/${org}`;
    const host = new URL(base).hostname;
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules: [{ hostPattern: host, purpose: 'connector', internal: false, allowHttp: false }], profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET', 'HEAD'] });
    const client = azureBoardsProvider.create(
      { organization: org, project: process.env.AZURE_BOARDS_LIVE_PROJECT!, baseUrl: base },
      { value: { token: process.env.AZURE_BOARDS_LIVE_TOKEN! }, expiresAt: new Date(Date.now() + 60_000), release() {} },
      { http },
    );
    expect((await client.testConnection()).ok).toBe(true);
  });
});
