import { describe, expect, it } from 'vitest';
import { PlatformError, type LoginStart, type OidcIdentityProvider, type VerifiedIdentity } from '@qa/domain';
import { InMemorySessionStore, OidcSessionResolver, buildApp, sanitizeReturnTo, type AuthConfig } from '../src';

class FakeProvider implements OidcIdentityProvider {
  groups = ['QA-Platform-Engineers'];
  fail = false;
  last?: LoginStart;
  async startLogin(): Promise<LoginStart> {
    this.last = { authorizationUrl: 'https://idp.example/auth?x=1', state: 'st-1', nonce: 'no-1', codeVerifier: 'cv-1' };
    return this.last;
  }
  async completeLogin(i: { codeVerifier: string; nonce: string }): Promise<VerifiedIdentity> {
    if (this.fail || i.nonce !== 'no-1' || i.codeVerifier !== 'cv-1') throw new PlatformError('auth', 'bad');
    return { subject: 'u-1', displayName: 'Dasun', groups: this.groups, idpSessionId: 'sid-1', idToken: 'idt' };
  }
  async verifyLogoutToken(t: string) {
    if (t !== 'good') throw new PlatformError('auth', 'bad');
    return { idpSessionId: 'sid-1' };
  }
  async endSessionUrl() {
    return 'https://idp.example/logout';
  }
}

function setup(over: Partial<AuthConfig> = {}) {
  const provider = new FakeProvider();
  let t = 1_000_000;
  const config: AuthConfig = { provider, store: new InMemorySessionStore(), publicBaseUrl: 'https://qa.example.local', now: () => t, ...over };
  const resolver = new OidcSessionResolver(config);
  const app = buildApp({ sessions: resolver, profile: 'standard', auth: { config, resolver } });
  return { app, provider, config, advance: (ms: number) => (t += ms) };
}

const cookieOf = (setCookie: string | string[] | undefined, name: string) => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0]! : undefined;
};

async function login(ctx: ReturnType<typeof setup>) {
  const start = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/login?returnTo=/runs' });
  expect(start.statusCode).toBe(302);
  const loginCookie = cookieOf(start.headers['set-cookie'], 'qa_login')!;
  const cb = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/callback?code=c&state=st-1', headers: { cookie: loginCookie } });
  return { cb, session: cookieOf(cb.headers['set-cookie'], 'qa_session') };
}

describe('OIDC login flow', () => {
  it('logs in, sets a hardened session cookie, redirects to returnTo, and resolves roles from groups', async () => {
    const ctx = setup();
    const { cb, session } = await login(ctx);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('https://qa.example.local/runs');
    const raw = ([] as string[]).concat(cb.headers['set-cookie'] as string[]).find((c) => c.startsWith('qa_session='))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Lax/);
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session! } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ userId: 'u-1', roles: ['qa_engineer'] });
  });

  it('rejects a callback without the login cookie, with a mismatching state, or with an IdP error', async () => {
    const ctx = setup();
    await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/callback?code=c&state=st-1' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/callback?code=c&state=st-1', headers: { cookie: 'qa_login=other' } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/callback?error=access_denied&state=st-1', headers: { cookie: 'qa_login=st-1' } })).statusCode).toBe(401);
  });

  it('does not allow a state to be replayed', async () => {
    const ctx = setup();
    await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/callback?code=c&state=st-1', headers: { cookie: 'qa_login=st-1' } });
    expect(ok.statusCode).toBe(302);
    const replay = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/callback?code=c&state=st-1', headers: { cookie: 'qa_login=st-1' } });
    expect(replay.statusCode).toBe(401);
  });

  it('denies login (403, no session) when no group maps to a role', async () => {
    const ctx = setup();
    ctx.provider.groups = ['Some-Other-Group'];
    const { cb, session } = await login(ctx);
    expect(cb.statusCode).toBe(403);
    expect(session).toBeUndefined();
  });

  it('refuses disabled users, and reports login, denial and logout through hooks without breaking the flow', async () => {
    const events: string[] = [];
    const ctx = setup({
      hooks: {
        isBlocked: async (s) => s === 'u-1' && events.includes('block'),
        onLogin: async (r) => void events.push(`login:${r.userId}`),
        onDenied: async (i) => void events.push(`denied:${i.subject}:${i.reason}`),
        onLogout: async () => {
          throw new Error('hook failure must not surface');
        },
      },
    });
    const ok = await login(ctx);
    expect(ok.cb.statusCode).toBe(302);
    const { csrfToken } = (await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: ok.session! } })).json();
    const out = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: ok.session!, 'x-csrf-token': csrfToken } });
    expect(out.statusCode).toBe(200);
    events.push('block');
    const blocked = await login(ctx);
    expect(blocked.cb.statusCode).toBe(403);
    expect(blocked.session).toBeUndefined();
    expect(events).toEqual(['login:u-1', 'block', 'denied:u-1:user-disabled']);
  });

  it('fails closed when the IdP rejects the exchange', async () => {
    const ctx = setup();
    ctx.provider.fail = true;
    const { cb } = await login(ctx);
    expect(cb.statusCode).toBe(401);
  });

  it('expires sessions after the idle timeout and the absolute timeout', async () => {
    const ctx = setup({ idleTimeoutMs: 60_000, absoluteTimeoutMs: 600_000 });
    const { session } = await login(ctx);
    ctx.advance(30_000);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session! } })).statusCode).toBe(200);
    ctx.advance(61_000);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session! } })).statusCode).toBe(401);

    const ctx2 = setup({ idleTimeoutMs: 60_000, absoluteTimeoutMs: 100_000 });
    const s2 = (await login(ctx2)).session;
    for (let i = 0; i < 3; i += 1) {
      ctx2.advance(40_000);
      await ctx2.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: s2! } });
    }
    expect((await ctx2.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: s2! } })).statusCode).toBe(401);
  });

  it('requires the CSRF token for state-changing requests; logout clears the session', async () => {
    const ctx = setup();
    const { session } = await login(ctx);
    const { csrfToken } = (await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: session! } })).json();
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: session! } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: session!, 'x-csrf-token': 'wrong' } })).statusCode).toBe(401);
    const out = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: session!, 'x-csrf-token': csrfToken } });
    expect(out.json()).toEqual({ loggedOut: true, logoutUrl: 'https://idp.example/logout' });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session! } })).statusCode).toBe(401);
  });

  it('back-channel logout ends the matching sessions and rejects invalid tokens', async () => {
    const ctx = setup();
    const { session } = await login(ctx);
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/backchannel-logout', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'logout_token=forged' });
    expect(bad.statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session! } })).statusCode).toBe(200);
    const good = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/backchannel-logout', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'logout_token=good' });
    expect(good.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session! } })).statusCode).toBe(401);
  });

  it('ignores dev headers when OIDC is the resolver', async () => {
    const ctx = setup();
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { 'x-dev-user': 'root', 'x-dev-groups': 'QA-Platform-Admins' } });
    expect(r.statusCode).toBe(401);
  });

  it('answers 503 with a generic body when the IdP is unreachable at login', async () => {
    const ctx = setup();
    ctx.provider.startLogin = async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:8080');
    };
    const r = await ctx.app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('10.1.2.3');
  });

  it('only accepts same-site relative returnTo paths', () => {
    expect(sanitizeReturnTo('/runs?id=1')).toBe('/runs?id=1');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', 'javascript:alert(1)', undefined, '/a\r\nSet-Cookie: x=1']) expect(sanitizeReturnTo(bad)).toBe('/');
  });
});
