import { createHash } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HttpPort, HttpRequest, HttpResponse } from '@qa/connector-sdk';
import { OidcProvider } from '../src';

const ISSUER = 'https://qa.example.local/auth/realms/qa-platform';
const CLIENT = 'qa-platform';
const REDIRECT = 'https://qa.example.local/api/v1/auth/callback';

const res = (status: number, body: unknown): HttpResponse => {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return { status, headers: {}, body: bytes, text: () => text, json: <T>() => JSON.parse(text) as T };
};

class FakeIdp implements HttpPort {
  calls: HttpRequest[] = [];
  keys: { kid: string; priv: Awaited<ReturnType<typeof generateKeyPair>>['privateKey']; jwk: JWK }[] = [];
  idTokenOverride?: string;
  claims: Record<string, unknown> = { name: 'Dasun', email: 'd@example.org', groups: ['QA-Platform-Leads'], sid: 'idp-sess-1' };

  async addKey(kid: string) {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    this.keys.push({ kid, priv: privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } });
  }

  async sign(over: Record<string, unknown> = {}, opts: { iss?: string; aud?: string; kid?: string; expSec?: number } = {}) {
    const k = this.keys.find((x) => x.kid === (opts.kid ?? this.keys.at(-1)!.kid))!;
    return new SignJWT({ ...this.claims, ...over })
      .setProtectedHeader({ alg: 'RS256', kid: k.kid })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? CLIENT)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(opts.expSec ?? Math.floor(Date.now() / 1000) + 300)
      .sign(k.priv);
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const u = new URL(req.url);
    if (u.pathname.endsWith('/.well-known/openid-configuration')) {
      return res(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
      });
    }
    if (u.pathname.endsWith('/certs')) return res(200, { keys: this.keys.map((k) => k.jwk) });
    if (u.pathname.endsWith('/token')) {
      const nonce = (this as unknown as { nonce: string }).nonce;
      return res(200, { id_token: this.idTokenOverride ?? (await this.sign({ nonce })) });
    }
    return res(404, {});
  }
}

describe('OidcProvider', () => {
  let idp: FakeIdp;
  let provider: OidcProvider;
  beforeAll(() => undefined);
  const setup = async () => {
    idp = new FakeIdp();
    await idp.addKey('k1');
    provider = new OidcProvider({ issuer: ISSUER, clientId: CLIENT, clientSecret: 's3cret' }, idp);
  };

  it('builds an authorization URL with PKCE S256, state and nonce', async () => {
    await setup();
    const s = await provider.startLogin(REDIRECT);
    const u = new URL(s.authorizationUrl);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(s.codeVerifier).digest('base64url'));
    expect(u.searchParams.get('state')).toBe(s.state);
    expect(u.searchParams.get('nonce')).toBe(s.nonce);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(s.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('completes login, sends the verifier and secret, and maps claims', async () => {
    await setup();
    const s = await provider.startLogin(REDIRECT);
    (idp as unknown as { nonce: string }).nonce = s.nonce;
    const id = await provider.completeLogin({ code: 'abc', redirectUri: REDIRECT, codeVerifier: s.codeVerifier, nonce: s.nonce });
    expect(id).toMatchObject({ subject: 'user-1', displayName: 'Dasun', groups: ['QA-Platform-Leads'], idpSessionId: 'idp-sess-1' });
    const tokenCall = idp.calls.find((c) => c.method === 'POST')!;
    const form = new URLSearchParams(tokenCall.body as string);
    expect(form.get('code_verifier')).toBe(s.codeVerifier);
    expect(form.get('grant_type')).toBe('authorization_code');
  });

  it.each([
    ['wrong nonce', { nonce: 'other' }, {}],
    ['wrong audience', {}, { aud: 'someone-else' }],
    ['wrong issuer', {}, { iss: 'https://evil.example/realms/x' }],
    ['expired token', {}, { expSec: Math.floor(Date.now() / 1000) - 3600 }],
  ])('rejects an ID token with %s', async (_n, claims, opts) => {
    await setup();
    const s = await provider.startLogin(REDIRECT);
    idp.idTokenOverride = await idp.sign({ nonce: s.nonce, ...claims }, opts);
    await expect(provider.completeLogin({ code: 'c', redirectUri: REDIRECT, codeVerifier: s.codeVerifier, nonce: s.nonce })).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('rejects a token signed by an unknown key and an alg=none token', async () => {
    await setup();
    const s = await provider.startLogin(REDIRECT);
    const rogue = new FakeIdp();
    await rogue.addKey('k1');
    idp.idTokenOverride = await rogue.sign({ nonce: s.nonce });
    await expect(provider.completeLogin({ code: 'c', redirectUri: REDIRECT, codeVerifier: s.codeVerifier, nonce: s.nonce })).rejects.toMatchObject({ errorClass: 'auth' });
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: ISSUER, aud: CLIENT, sub: 'x', nonce: s.nonce, exp: 9999999999, groups: ['QA-Platform-Admins'] })).toString('base64url');
    idp.idTokenOverride = `${header}.${body}.`;
    await expect(provider.completeLogin({ code: 'c', redirectUri: REDIRECT, codeVerifier: s.codeVerifier, nonce: s.nonce })).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('refetches the key set once after key rotation', async () => {
    await setup();
    const s = await provider.startLogin(REDIRECT);
    (idp as unknown as { nonce: string }).nonce = s.nonce;
    await provider.completeLogin({ code: 'c', redirectUri: REDIRECT, codeVerifier: s.codeVerifier, nonce: s.nonce });
    await idp.addKey('k2');
    const s2 = await provider.startLogin(REDIRECT);
    (idp as unknown as { nonce: string }).nonce = s2.nonce;
    const id = await provider.completeLogin({ code: 'c', redirectUri: REDIRECT, codeVerifier: s2.codeVerifier, nonce: s2.nonce });
    expect(id.subject).toBe('user-1');
  });

  it('rewrites IdP calls to the internal URL but keeps browser-facing URLs public', async () => {
    idp = new FakeIdp();
    await idp.addKey('k1');
    provider = new OidcProvider({ issuer: ISSUER, clientId: CLIENT, clientSecret: 'x', internalBaseUrl: 'http://keycloak:8080' }, idp);
    const s = await provider.startLogin(REDIRECT);
    expect(idp.calls[0]!.url.startsWith('http://keycloak:8080/auth/realms/qa-platform/')).toBe(true);
    expect(s.authorizationUrl.startsWith('https://qa.example.local/')).toBe(true);
  });

  it('validates back-channel logout tokens', async () => {
    await setup();
    const ev = { 'http://schemas.openid.net/event/backchannel-logout': {} };
    const ok = await idp.sign({ events: ev, sid: 'abc', groups: undefined, name: undefined, email: undefined });
    await expect(provider.verifyLogoutToken(ok)).resolves.toMatchObject({ idpSessionId: 'abc' });
    await expect(provider.verifyLogoutToken(await idp.sign({ sid: 'abc' }))).rejects.toMatchObject({ errorClass: 'auth' });
    await expect(provider.verifyLogoutToken(await idp.sign({ events: ev, nonce: 'n', sid: 'abc' }))).rejects.toMatchObject({ errorClass: 'auth' });
  });

  it('builds an RP-initiated logout URL', async () => {
    await setup();
    const u = new URL((await provider.endSessionUrl('tok', 'https://qa.example.local'))!);
    expect(u.searchParams.get('id_token_hint')).toBe('tok');
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('https://qa.example.local');
  });
});
