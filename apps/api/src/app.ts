import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isPlatformError, type DeploymentProfile } from '@qa/domain';
import { HealthResponse, LlmProvidersResponse, MePermissionsResponse, type ErrorResponse } from '@qa/contracts';
import {
  DEFAULT_GROUP_MAPPINGS, PolicyEngine, authenticatedRoute, publicRoute, requires, type GroupMapping, type Principal, type RouteAccess,
} from '@qa/security';
import type { SessionResolver } from './session';
import { registerRequestTelemetry } from './telemetry';
import { registerAuthRoutes, type AuthConfig, type OidcSessionResolver } from './auth';
import { registerConnectorRoutes, type ConnectorRouteDeps } from './connector-routes';

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppDeps {
  sessions: SessionResolver;
  profile: DeploymentProfile;
  mappings?: readonly GroupMapping[];
  readiness?: Record<string, () => Promise<boolean>>;
  /** When present, the OIDC login routes are registered; `sessions` must be the matching resolver. */
  /** Read-only view of configured model providers for the AI Models screen. */
  llm?: { providers(): Promise<LlmProvidersResponse['items']> };
  auth?: { config: AuthConfig; resolver: OidcSessionResolver };
  /** Connector management. Without it the connector list stays empty. */
  connectors?: ConnectorRouteDeps;
}

const CLIENT_ERRORS: Partial<Record<string, number>> = { validation: 400, 'not-found': 404, conflict: 409, unsupported: 400 };

const err = (cls: string, message: string): ErrorResponse => ({ error: { class: cls, message } });

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const policy = new PolicyEngine();
  registerRequestTelemetry(app);

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.setErrorHandler((e, _req, reply) => {
    const status = (e as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send(err('validation', 'Bad request'));
    if (isPlatformError(e) && e.errorClass === 'transient') return reply.code(503).send(err('transient', 'Dependency unavailable'));
    // Service messages for these classes are written for users and never contain submitted values.
    const clientStatus = isPlatformError(e) ? CLIENT_ERRORS[e.errorClass] : undefined;
    if (isPlatformError(e) && clientStatus) return reply.code(clientStatus).send(err(e.errorClass, e.message));
    return reply.code(500).send(err('internal', 'Internal error'));
  });

  // Fail at startup, not at review time, if any route forgets to declare its access rule.
  app.addHook('onRoute', (route) => {
    if (!route.config?.access) {
      throw new Error(`Route ${String(route.method)} ${route.url} must declare config.access (public | authenticated | permission)`);
    }
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const access = req.routeOptions.config.access;
    if (!access || access.kind === 'public') return;
    const principal = await deps.sessions.resolve(req);
    if (!principal) return reply.code(401).send(err('auth', 'Authentication required'));
    req.principal = principal;
    if (access.kind === 'permission') {
      const d = policy.can(principal, access.permission);
      if (!d.allow) return reply.code(403).send(err('denied', 'Forbidden'));
    }
  });

  if (deps.auth) registerAuthRoutes(app, deps.auth.resolver, deps.auth.config);

  app.get('/healthz', { config: { access: publicRoute } }, async () => HealthResponse.parse({ status: 'ok', profile: deps.profile }));

  app.get('/readyz', { config: { access: publicRoute } }, async (_req, reply) => {
    const results = await Promise.all(Object.entries(deps.readiness ?? {}).map(async ([k, f]) => [k, await f().catch(() => false)] as const));
    const failing = results.filter(([, ok]) => !ok).map(([k]) => k);
    if (failing.length > 0) return reply.code(503).send({ status: 'degraded', failing });
    return { status: 'ok' };
  });

  app.get('/api/v1/me', { config: { access: authenticatedRoute } }, async (req) => {
    const p = req.principal!;
    return MePermissionsResponse.parse({
      userId: p.id,
      displayName: p.displayName,
      roles: [...p.roles],
      permissions: [...policy.permissionsOf(p)].sort(),
    });
  });

  app.get('/api/v1/identity/mappings', { config: { access: requires('user.manage') } }, async () => ({
    items: (deps.mappings ?? DEFAULT_GROUP_MAPPINGS).map((m) => ({ idpGroup: m.idpGroup, role: m.role, enabled: m.enabled !== false })),
  }));

  if (deps.connectors) registerConnectorRoutes(app, deps.connectors, policy);
  else app.get('/api/v1/connectors', { config: { access: requires('connector.view_status') } }, async () => ({ items: [] }));

  app.get('/api/v1/llm/providers', { config: { access: requires('llm.view') } }, async () =>
    LlmProvidersResponse.parse({ items: deps.llm ? await deps.llm.providers() : [] }),
  );

  return app;
}
