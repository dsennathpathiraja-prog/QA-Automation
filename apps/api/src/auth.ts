import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OidcIdentityProvider, SessionRecord, SessionStore } from '@qa/domain';
import { PlatformError } from '@qa/domain';
import { DEFAULT_GROUP_MAPPINGS, mapGroupsToRoles, publicRoute, authenticatedRoute, type GroupFormat, type GroupMapping, type Principal } from '@qa/security';
import { isRole } from '@qa/domain';
import type { SessionResolver } from './session';

export interface AuthConfig {
  provider: OidcIdentityProvider;
  store: SessionStore;
  /** Public base URL of the platform as seen by the browser, e.g. https://qa.example.org */
  publicBaseUrl: string;
  mappings?: readonly GroupMapping[];
  groupFormat?: GroupFormat;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  /** False only for local http development. */
  secureCookies?: boolean;
  now?: () => number;
  /** Side effects after authentication decisions (user provisioning, audit). Failures never block or leak into the response. */
  hooks?: {
    onLogin?(rec: SessionRecord): Promise<void>;
    isBlocked?(subject: string): Promise<boolean>;
    onDenied?(info: { subject: string; reason: string }): Promise<void>;
    onLogout?(rec: SessionRecord): Promise<void>;
  };
}

const SESSION_COOKIE = 'qa_session';
const LOGIN_COOKIE = 'qa_login';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Only same-site relative paths survive; anything else falls back to the root. */
export function sanitizeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\') || /[\r\n]/.test(v)) return '/';
  return v;
}

interface PendingLogin {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  expiresAt: number;
}

export class OidcSessionResolver implements SessionResolver {
  private readonly now: () => number;
  private readonly idle: number;
  private readonly absolute: number;
  private readonly mappings: readonly GroupMapping[];

  constructor(private readonly cfg: AuthConfig) {
    this.now = cfg.now ?? Date.now;
    this.idle = cfg.idleTimeoutMs ?? 30 * 60_000;
    this.absolute = cfg.absoluteTimeoutMs ?? 8 * 3_600_000;
    this.mappings = cfg.mappings ?? DEFAULT_GROUP_MAPPINGS;
  }

  async resolve(req: FastifyRequest): Promise<Principal | undefined> {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return undefined;
    const rec = await this.cfg.store.get(id);
    if (!rec) return undefined;
    const t = this.now();
    if (t >= rec.expiresAt || t - rec.lastSeenAt >= this.idle) {
      await this.cfg.store.delete(id);
      return undefined;
    }
    // Cookie-authenticated state-changing requests must prove they came from the SPA.
    if (!SAFE_METHODS.has(req.method.toUpperCase())) {
      const h = req.headers['x-csrf-token'];
      if (typeof h !== 'string' || !safeEqual(h, rec.csrfToken)) return undefined;
    }
    await this.cfg.store.touch(id, t);
    req.sessionRecord = rec;
    return { id: rec.userId, displayName: rec.displayName, roles: rec.roles.filter(isRole) };
  }

  /** Builds a session from verified claims, or returns undefined when the user has no mapped role. */
  async createSession(identity: { subject: string; displayName: string; email?: string; groups: string[]; idpSessionId?: string; idToken: string }): Promise<SessionRecord | undefined> {
    const { roles, authorized } = mapGroupsToRoles(identity.groups, { mappings: this.mappings, groupFormat: this.cfg.groupFormat });
    if (!authorized) return undefined;
    const t = this.now();
    const rec: SessionRecord = {
      id: randomBytes(32).toString('base64url'),
      userId: identity.subject,
      displayName: identity.displayName,
      email: identity.email,
      groups: identity.groups,
      roles,
      csrfToken: randomBytes(24).toString('base64url'),
      idToken: identity.idToken,
      idpSessionId: identity.idpSessionId,
      createdAt: t,
      lastSeenAt: t,
      expiresAt: t + this.absolute,
    };
    await this.cfg.store.create(rec);
    return rec;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    sessionRecord?: SessionRecord;
  }
}

export function registerAuthRoutes(app: FastifyInstance, resolver: OidcSessionResolver, cfg: AuthConfig): void {
  const now = cfg.now ?? Date.now;
  const secure = cfg.secureCookies ?? true;
  const base = cfg.publicBaseUrl.replace(/\/$/, '');
  const redirectUri = `${base}/api/v1/auth/callback`;
  const pending = new Map<string, PendingLogin>();

  const cookie = (name: string, value: string, maxAgeSec: number, path: string) =>
    `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  // The callback is a browser navigation, so failures land on a readable SPA page instead of a JSON body.
  const bounce = (reply: FastifyReply, code: 'failed' | 'denied' | 'unavailable') => reply.redirect(`${base}/signin-error?code=${code}`, 302);

  app.get('/api/v1/auth/login', { config: { access: publicRoute } }, async (req, reply) => {
    for (const [k, v] of pending) if (v.expiresAt <= now()) pending.delete(k);
    const start = await cfg.provider.startLogin(redirectUri).catch(() => undefined);
    if (!start) return reply.code(503).send({ error: { class: 'transient', message: 'Identity provider unavailable' } });
    const returnTo = sanitizeReturnTo((req.query as { returnTo?: string }).returnTo);
    pending.set(start.state, { nonce: start.nonce, codeVerifier: start.codeVerifier, returnTo, expiresAt: now() + 10 * 60_000 });
    // The cookie binds the pending login to this browser; the state parameter alone is not enough.
    reply.header('set-cookie', cookie(LOGIN_COOKIE, start.state, 600, '/api/v1/auth'));
    return reply.redirect(start.authorizationUrl, 302);
  });

  app.get('/api/v1/auth/callback', { config: { access: publicRoute } }, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const bound = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
    const clearLogin = cookie(LOGIN_COOKIE, '', 0, '/api/v1/auth');
    if (q.error || !q.code || !q.state || !bound || !safeEqual(q.state, bound)) {
      reply.header('set-cookie', clearLogin);
      return bounce(reply, 'failed');
    }
    const p = pending.get(q.state);
    pending.delete(q.state);
    if (!p || p.expiresAt <= now()) {
      reply.header('set-cookie', clearLogin);
      return bounce(reply, 'failed');
    }
    let rec: SessionRecord | undefined;
    let subject = 'unknown';
    let blocked = false;
    try {
      const identity = await cfg.provider.completeLogin({ code: q.code, redirectUri, codeVerifier: p.codeVerifier, nonce: p.nonce });
      subject = identity.subject;
      blocked = (await cfg.hooks?.isBlocked?.(identity.subject)) ?? false;
      if (!blocked) rec = await resolver.createSession(identity);
    } catch (e) {
      reply.header('set-cookie', clearLogin);
      if (e instanceof PlatformError && e.errorClass === 'transient') return bounce(reply, 'unavailable');
      return bounce(reply, 'failed');
    }
    if (!rec) {
      await cfg.hooks?.onDenied?.({ subject, reason: blocked ? 'user-disabled' : 'no-mapped-role' }).catch(() => undefined);
      reply.header('set-cookie', clearLogin);
      return bounce(reply, 'denied');
    }
    await cfg.hooks?.onLogin?.(rec).catch(() => undefined);
    reply.header('set-cookie', [clearLogin, cookie(SESSION_COOKIE, rec.id, Math.floor((rec.expiresAt - now()) / 1000), '/')]);
    return reply.redirect(`${base}${p.returnTo}`, 302);
  });

  app.get('/api/v1/auth/session', { config: { access: authenticatedRoute } }, async (req) => ({
    csrfToken: req.sessionRecord!.csrfToken,
    expiresAt: new Date(req.sessionRecord!.expiresAt).toISOString(),
  }));

  app.post('/api/v1/auth/backchannel-logout', { config: { access: publicRoute } }, async (req, reply) => {
    const token = (req.body as { logout_token?: string } | undefined)?.logout_token;
    if (typeof token !== 'string') return reply.code(400).send({ error: { class: 'validation', message: 'logout_token required' } });
    try {
      const { idpSessionId, subject } = await cfg.provider.verifyLogoutToken(token);
      if (idpSessionId) await cfg.store.deleteByIdpSession(idpSessionId);
      else if (subject) await cfg.store.deleteByUser(subject);
      return reply.code(200).send({});
    } catch {
      return reply.code(400).send({ error: { class: 'validation', message: 'invalid logout token' } });
    }
  });

  app.post('/api/v1/auth/logout', { config: { access: authenticatedRoute } }, async (req, reply) => {
    const rec = req.sessionRecord!;
    await cfg.store.delete(rec.id);
    await cfg.hooks?.onLogout?.(rec).catch(() => undefined);
    reply.header('set-cookie', cookie(SESSION_COOKIE, '', 0, '/'));
    const logoutUrl = await cfg.provider.endSessionUrl(rec.idToken, base).catch(() => undefined);
    return { loggedOut: true, logoutUrl: logoutUrl ?? null };
  });
}
