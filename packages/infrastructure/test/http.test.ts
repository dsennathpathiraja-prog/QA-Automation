import { describe, expect, it } from 'vitest';
import { EgressPolicy, HardenedHttpClient, isReadOnlyGraphQL, matchHost, type EgressRule, type FetchLike } from '../src';

const rules: EgressRule[] = [
  { hostPattern: 'api.github.com', purpose: 'connector', internal: false },
  { hostPattern: '*.dev.azure.com', purpose: 'connector', internal: false },
  { hostPattern: 'jira.corp.local', purpose: 'connector', internal: true, allowHttp: true },
  { hostPattern: 'localhost', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true },
];
const policy = (profile: 'standard' | 'airgapped' = 'standard', platformEnv: 'test' | 'production' = 'test') => new EgressPolicy({ rules, profile, platformEnv });
const u = (s: string) => new URL(s);

describe('EgressPolicy', () => {
  it('denies hosts that are not approved', () => {
    expect(() => policy().assertAllowed(u('https://evil.example.com/x'))).toThrow(/not on the approved-host list/);
  });
  it('allows approved hosts over https and wildcard subdomains', () => {
    expect(policy().assertAllowed(u('https://api.github.com/repos')).hostPattern).toBe('api.github.com');
    expect(policy().assertAllowed(u('https://acme.dev.azure.com/')).hostPattern).toBe('*.dev.azure.com');
    expect(() => policy().assertAllowed(u('https://dev.azure.com/'))).toThrow();
  });
  it('rejects plain http unless the host is internal and http-enabled', () => {
    expect(() => policy().assertAllowed(u('http://api.github.com'))).toThrow(/plain http/);
    expect(policy().assertAllowed(u('http://jira.corp.local/rest')).internal).toBe(true);
  });
  it('rejects non-http protocols', () => {
    expect(() => policy().assertAllowed(u('ftp://api.github.com'))).toThrow(/protocol/);
  });
  it('blocks external hosts in the air-gapped profile', () => {
    expect(() => policy('airgapped').assertAllowed(u('https://api.github.com'))).toThrow(/air-gapped/);
    expect(policy('airgapped').assertAllowed(u('http://jira.corp.local')).internal).toBe(true);
  });
  it('blocks metadata, loopback and private addresses unless internal', () => {
    const ext = rules[0]!;
    const int = rules[2]!;
    expect(() => policy().assertIps(['169.254.169.254'], int)).toThrow(/blocked range/);
    expect(() => policy().assertIps(['10.0.0.5'], ext)).toThrow(/private/);
    expect(() => policy().assertIps(['10.0.0.5'], int)).not.toThrow();
    expect(() => policy().assertIps(['127.0.0.1'], int)).toThrow(/loopback/);
    expect(() => policy().assertIps(['fd00::1'], ext)).toThrow(/private/);
    expect(() => policy().assertIps(['::1'], ext)).toThrow(/loopback/);
  });
  it('allows loopback only for opted-in rules outside production', () => {
    const local = rules[3]!;
    expect(() => policy('standard', 'test').assertIps(['127.0.0.1'], local)).not.toThrow();
    expect(() => policy('standard', 'production').assertIps(['127.0.0.1'], local)).toThrow(/loopback/);
  });
  it('matches wildcard patterns strictly', () => {
    expect(matchHost('*.example.com', 'a.example.com')).toBe(true);
    expect(matchHost('*.example.com', 'example.com')).toBe(false);
    expect(matchHost('*.example.com', 'evilexample.com')).toBe(false);
  });
});

const okFetch = (calls: string[]): FetchLike => async (url, init) => {
  calls.push(`${String(init.method)} ${url}`);
  return { status: 200, headers: { forEach: (cb) => cb('application/json', 'content-type') }, arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer };
};

describe('HardenedHttpClient', () => {
  const mk = (over: Partial<ConstructorParameters<typeof HardenedHttpClient>[0]> = {}, calls: string[] = []) =>
    new HardenedHttpClient({ egress: policy(), resolve: async () => ['140.82.112.5'], fetchImpl: okFetch(calls), ...over });

  it('performs allowed requests and returns parsed bodies', async () => {
    const calls: string[] = [];
    const res = await mk({}, calls).request({ method: 'GET', url: 'https://api.github.com/repos/x/y' });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls).toEqual(['GET https://api.github.com/repos/x/y']);
  });

  it('strips URL userinfo before fetch so clients cannot emit Authorization: Basic', async () => {
    const calls: string[] = [];
    const headersSeen: Array<Record<string, string> | undefined> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push(`${String(init.method)} ${url}`);
      headersSeen.push(init.headers as Record<string, string> | undefined);
      return { status: 200, headers: { forEach: (cb) => cb('application/json', 'content-type') }, arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer as ArrayBuffer };
    };
    const c = new HardenedHttpClient({ egress: policy(), resolve: async () => ['140.82.112.5'], fetchImpl });
    await c.request({
      method: 'GET',
      url: 'https://user:pass@api.github.com/repos/x/y',
      headers: { Authorization: 'Bearer tok-from-header' },
    });
    expect(calls).toEqual(['GET https://api.github.com/repos/x/y']);
    expect(calls[0]).not.toMatch(/user:pass@/);
    expect(headersSeen[0]?.Authorization ?? headersSeen[0]?.authorization).toBe('Bearer tok-from-header');
  });

  it('enforces the method allowlist (read-only providers)', async () => {
    const calls: string[] = [];
    const c = mk({ allowedMethods: ['GET', 'HEAD'] }, calls);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(c.request({ method: m, url: 'https://api.github.com/repos/x/y/git/refs' })).rejects.toMatchObject({ errorClass: 'denied' });
    }
    expect(calls).toEqual([]);
  });

  it('allows read-only GraphQL queries but rejects mutations', async () => {
    const calls: string[] = [];
    const c = mk({ allowedMethods: ['GET'], allowOther: (r) => r.method === 'POST' && r.url.endsWith('/graphql') && typeof r.body === 'string' && isReadOnlyGraphQL(r.body) }, calls);
    const q = JSON.stringify({ query: 'query { viewer { login } }' });
    const m = JSON.stringify({ query: 'mutation { createRef(input:{}) { ref { id } } }' });
    await expect(c.request({ method: 'POST', url: 'https://api.github.com/graphql', body: q })).resolves.toBeTruthy();
    await expect(c.request({ method: 'POST', url: 'https://api.github.com/graphql', body: m })).rejects.toMatchObject({ errorClass: 'denied' });
    expect(calls).toHaveLength(1);
  });

  it('blocks DNS answers pointing at private or metadata addresses (rebinding)', async () => {
    const calls: string[] = [];
    await expect(mk({ resolve: async () => ['169.254.169.254'] }, calls).request({ method: 'GET', url: 'https://api.github.com/' })).rejects.toThrow(/blocked range/);
    await expect(mk({ resolve: async () => ['10.1.1.1'] }, calls).request({ method: 'GET', url: 'https://api.github.com/' })).rejects.toThrow(/private/);
    await expect(mk({ resolve: async () => ['140.82.112.5', '10.1.1.1'] }, calls).request({ method: 'GET', url: 'https://api.github.com/' })).rejects.toThrow(/private/);
    expect(calls).toEqual([]);
  });

  it('allows internal hosts that resolve to private addresses', async () => {
    const c = new HardenedHttpClient({ egress: policy(), resolve: async () => ['10.2.3.4'], fetchImpl: okFetch([]) });
    await expect(c.request({ method: 'GET', url: 'http://jira.corp.local/rest/api' })).resolves.toBeTruthy();
  });

  it('re-validates every redirect hop against the egress policy', async () => {
    const f: FetchLike = async (url) =>
      url.startsWith('https://api.github.com')
        ? { status: 302, headers: { forEach: (cb) => cb('https://evil.example.com/steal', 'location') }, arrayBuffer: async () => new ArrayBuffer(0) }
        : { status: 200, headers: { forEach: () => undefined }, arrayBuffer: async () => new ArrayBuffer(0) };
    await expect(new HardenedHttpClient({ egress: policy(), resolve: async () => ['140.82.112.5'], fetchImpl: f }).request({ method: 'GET', url: 'https://api.github.com/x' })).rejects.toThrow(/approved-host list/);
  });

  it('does not follow redirects for unsafe methods', async () => {
    const f: FetchLike = async () => ({ status: 307, headers: { forEach: (cb) => cb('https://api.github.com/other', 'location') }, arrayBuffer: async () => new ArrayBuffer(0) });
    await expect(new HardenedHttpClient({ egress: policy(), resolve: async () => ['140.82.112.5'], fetchImpl: f }).request({ method: 'POST', url: 'https://api.github.com/x' })).rejects.toThrow(/redirects/);
  });

  it('wraps DNS failures as a PlatformError instead of a raw lookup error', async () => {
    const c = new HardenedHttpClient({
      egress: policy(),
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND missing.service'), { code: 'ENOTFOUND' });
      },
      fetchImpl: okFetch([]),
    });
    await expect(c.request({ method: 'GET', url: 'https://api.github.com/' })).rejects.toMatchObject({
      errorClass: 'transient',
      message: expect.stringMatching(/could not resolve api\.github\.com/),
    });
  });

  it('labels connection refused distinctly from other network errors', async () => {
    const f: FetchLike = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.2.3.4:8931'), { code: 'ECONNREFUSED' });
    };
    await expect(
      new HardenedHttpClient({ egress: policy(), resolve: async () => ['10.2.3.4'], fetchImpl: f }).request({
        method: 'GET',
        url: 'http://jira.corp.local/x',
      }),
    ).rejects.toMatchObject({
      errorClass: 'transient',
      message: expect.stringMatching(/connection refused/i),
    });
  });

  it('really connects to the pinned address (integration against a local server)', async () => {
    const { createServer } = await import('node:http');
    const srv = createServer((_, res) => res.end('pong'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const c = new HardenedHttpClient({ egress: policy(), resolve: async () => ['127.0.0.1'] });
      const res = await c.request({ method: 'GET', url: `http://localhost:${port}/` });
      expect(res.text()).toBe('pong');
      const prod = new HardenedHttpClient({ egress: policy('standard', 'production'), resolve: async () => ['127.0.0.1'] });
      await expect(prod.request({ method: 'GET', url: `http://localhost:${port}/` })).rejects.toThrow(/loopback/);
    } finally {
      srv.close();
    }
  });
});

describe('isReadOnlyGraphQL', () => {
  const body = (q: string) => JSON.stringify({ query: q });
  it('accepts queries, including the word mutation inside strings or comments', () => {
    expect(isReadOnlyGraphQL(body('query Q { repository(name: "mutation") { id } }'))).toBe(true);
    expect(isReadOnlyGraphQL(body('# mutation\n{ viewer { login } }'))).toBe(true);
    expect(isReadOnlyGraphQL(body('query { a { mutation } }'))).toBe(true);
  });
  it('rejects mutations and subscriptions, however spaced', () => {
    expect(isReadOnlyGraphQL(body('mutation{x}'))).toBe(false);
    expect(isReadOnlyGraphQL(body('query A{a} mutation B{b}'))).toBe(false);
    expect(isReadOnlyGraphQL(body('\n  subscription S { s }'))).toBe(false);
  });
  it('rejects malformed or non-JSON bodies', () => {
    expect(isReadOnlyGraphQL('not json')).toBe(false);
    expect(isReadOnlyGraphQL(JSON.stringify({}))).toBe(false);
    expect(isReadOnlyGraphQL(body('query { "unterminated '))).toBe(false);
  });
});
