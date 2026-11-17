import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { PlatformError, type LoginStart, type OidcIdentityProvider, type VerifiedIdentity } from '@qa/domain';
import type { HttpPort } from '@qa/connector-sdk';

export interface OidcProviderConfig {
  /** Issuer URL exactly as it appears in the `iss` claim. */
  issuer: string;
  /** URL the platform uses to reach the IdP (may differ from the public issuer inside Compose). */
  internalBaseUrl?: string;
  clientId: string;
  /** Resolved from the secret store by the composition root; never logged. */
  clientSecret: string;
  scopes?: string[];
  /** Claim holding group names. Keycloak: `groups`; Entra: `groups` (object ids) or a custom claim. */
  groupsClaim?: string;
  clockToleranceSec?: number;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  issuer: string;
}

const b64url = (b: Buffer) => b.toString('base64url');

export class OidcProvider implements OidcIdentityProvider {
  private discovery?: { value: Discovery; at: number };
  private jwks?: { set: ReturnType<typeof createLocalJWKSet>; keys: JSONWebKeySet; at: number };

  constructor(
    private readonly cfg: OidcProviderConfig,
    private readonly http: HttpPort,
    private readonly now: () => number = Date.now,
  ) {}

  private rewrite(url: string): string {
    if (!this.cfg.internalBaseUrl) return url;
    const pub = new URL(this.cfg.issuer);
    const u = new URL(url);
    if (u.origin !== pub.origin) return url;
    return new URL(u.pathname + u.search, this.cfg.internalBaseUrl).toString();
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.http.request({ method: 'GET', url: this.rewrite(url), headers: { accept: 'application/json' } });
    if (res.status !== 200) throw new PlatformError('transient', `IdP request failed with status ${res.status}`);
    return res.json<T>();
  }

  private async getDiscovery(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.at < 3_600_000) return this.discovery.value;
    const url = `${this.cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const value = await this.getJson<Discovery>(url);
    if (value.issuer !== this.cfg.issuer) throw new PlatformError('auth', 'IdP discovery issuer does not match configuration');
    this.discovery = { value, at: this.now() };
    return value;
  }

  private async keySet(forceRefresh: boolean) {
    if (!forceRefresh && this.jwks && this.now() - this.jwks.at < 600_000) return this.jwks.set;
    const d = await this.getDiscovery();
    const keys = await this.getJson<JSONWebKeySet>(d.jwks_uri);
    this.jwks = { set: createLocalJWKSet(keys), keys, at: this.now() };
    return this.jwks.set;
  }

  async startLogin(redirectUri: string): Promise<LoginStart> {
    const d = await this.getDiscovery();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const codeVerifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(codeVerifier).digest());
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', (this.cfg.scopes ?? ['openid', 'profile', 'email']).join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: u.toString(), state, nonce, codeVerifier };
  }

  async completeLogin(input: { code: string; redirectUri: string; codeVerifier: string; nonce: string }): Promise<VerifiedIdentity> {
    const d = await this.getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: input.codeVerifier,
    }).toString();
    const res = await this.http.request({
      method: 'POST',
      url: this.rewrite(d.token_endpoint),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (res.status !== 200) throw new PlatformError('auth', 'Token exchange was rejected by the identity provider');
    const idToken = res.json<{ id_token?: string }>().id_token;
    if (!idToken) throw new PlatformError('auth', 'Identity provider returned no ID token');

    const verify = async (force: boolean) =>
      jwtVerify(idToken, await this.keySet(force), {
        issuer: this.cfg.issuer,
        audience: this.cfg.clientId,
        algorithms: ['RS256', 'ES256', 'PS256'],
        clockTolerance: this.cfg.clockToleranceSec ?? 30,
        currentDate: new Date(this.now()),
      });
    let payload;
    try {
      payload = (await verify(false)).payload;
    } catch (e) {
      // Key rotation: refetch once, then fail closed.
      if ((e as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw new PlatformError('auth', 'ID token validation failed');
      try {
        payload = (await verify(true)).payload;
      } catch {
        throw new PlatformError('auth', 'ID token validation failed');
      }
    }
    if (payload.nonce !== input.nonce) throw new PlatformError('auth', 'ID token nonce mismatch');
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new PlatformError('auth', 'ID token has no subject');

    const raw = payload[this.cfg.groupsClaim ?? 'groups'];
    const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : [];
    const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined);
    return {
      subject: payload.sub,
      displayName: str('name') ?? str('preferred_username') ?? payload.sub,
      email: str('email'),
      groups,
      idpSessionId: str('sid'),
      idToken,
    };
  }

  async verifyLogoutToken(token: string): Promise<{ idpSessionId?: string; subject?: string }> {
    const opts = {
      issuer: this.cfg.issuer,
      audience: this.cfg.clientId,
      algorithms: ['RS256', 'ES256', 'PS256'],
      clockTolerance: this.cfg.clockToleranceSec ?? 30,
      currentDate: new Date(this.now()),
    };
    let payload;
    try {
      try {
        payload = (await jwtVerify(token, await this.keySet(false), opts)).payload;
      } catch (e) {
        if ((e as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw e;
        payload = (await jwtVerify(token, await this.keySet(true), opts)).payload;
      }
    } catch {
      throw new PlatformError('auth', 'logout token validation failed');
    }
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || !('http://schemas.openid.net/event/backchannel-logout' in events)) throw new PlatformError('auth', 'not a logout token');
    if ('nonce' in payload) throw new PlatformError('auth', 'logout token must not contain a nonce');
    const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
    const sub = typeof payload.sub === 'string' ? payload.sub : undefined;
    if (!sid && !sub) throw new PlatformError('auth', 'logout token has neither sid nor sub');
    return { idpSessionId: sid, subject: sub };
  }

  async endSessionUrl(idToken: string, postLogoutRedirectUri: string): Promise<string | undefined> {
    const d = await this.getDiscovery();
    if (!d.end_session_endpoint) return undefined;
    const u = new URL(d.end_session_endpoint);
    u.searchParams.set('id_token_hint', idToken);
    u.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    u.searchParams.set('client_id', this.cfg.clientId);
    return u.toString();
  }
}
