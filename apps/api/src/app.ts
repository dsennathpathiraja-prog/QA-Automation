import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type DeploymentProfile } from '@qa/domain';
import { HealthResponse, MePermissionsResponse, type ErrorResponse } from '@qa/contracts';
import {
  DEFAULT_GROUP_MAPPINGS, PolicyEngine, authenticatedRoute, publicRoute, requires, type GroupMapping, type Principal, type RouteAccess,
} from '@qa/security';
import type { SessionResolver } from './session';

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
}

const err = (cls: string, message: string): ErrorResponse => ({ error: { class: cls, message } });

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const policy = new PolicyEngine();

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

  app.get('/api/v1/connectors', { config: { access: requires('connector.view_status') } }, async () => ({ items: [] }));

  return app;
}
