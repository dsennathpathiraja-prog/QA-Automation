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
import { registerEnvironmentRoutes } from './environment-routes';
import { registerWorkflowRoutes } from './workflow-routes';
import { registerTestCaseRoutes } from './test-case-routes';
import { registerAutomationRoutes } from './automation-routes';
import {
  caseIdsFromPlatformCollection,
  RegressionScopeService,
  type AutomationService,
  type EnvironmentService,
  type RegressionCollectionService,
  type TestCaseService,
  type WorkflowService,
} from '@qa/application';

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
  /** Environment management. Without it the environment list stays empty. */
  environments?: EnvironmentService;
  workflows?: WorkflowService;
  testCases?: TestCaseService;
  automation?: AutomationService;
  /** Phase 9 E4 — curated smoke / platform regression collections. */
  regressionCollections?: RegressionCollectionService;
}

const CLIENT_ERRORS: Partial<Record<string, number>> = { validation: 400, 'not-found': 404, conflict: 409, unsupported: 400, denied: 403 };

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

  if (deps.environments) registerEnvironmentRoutes(app, deps.environments);
  else app.get('/api/v1/environments', { config: { access: requires('environment.view') } }, async () => ({ items: [] }));

  if (deps.workflows) registerWorkflowRoutes(app, deps.workflows);
  else app.get('/api/v1/workflows', { config: { access: requires('workflow.view_published') } }, async () => ({ items: [] }));

  if (deps.testCases) registerTestCaseRoutes(app, deps.testCases, deps.environments);
  else {
    app.get('/api/v1/test-cases', { config: { access: requires('testcase.view') } }, async () => ({ items: [] }));
    app.get('/api/v1/test-collections', { config: { access: requires('testcase.view') } }, async () => ({ items: [] }));
    app.get('/api/v1/work-item-executions', { config: { access: requires('execution.start') } }, async () => ({ workItems: [], environments: [], items: [] }));
  }

  if (deps.automation) {
    const scope = new RegressionScopeService({
      collections: deps.regressionCollections || deps.testCases
        ? {
          caseIdsForCollectionKey: async (key) => {
            if (deps.regressionCollections) {
              const curated = await deps.regressionCollections.caseIdsForKey(key);
              if (curated !== undefined) return curated;
            }
            if (!deps.testCases) return undefined;
            return caseIdsFromPlatformCollection({
              collectionKey: key,
              listCollections: () => deps.testCases!.collections(),
              getCollection: (id) => deps.testCases!.collection(id).then((c) => ({ cases: c.cases })).catch(() => undefined),
              listAssets: () => deps.automation!.listAssets(),
              listMappings: () => deps.automation!.listMappings(),
            });
          },
        }
        : undefined,
      // Suite/campaign Squash expansion runs on the worker; prep API still accepts caseIds overrides.
    });
    registerAutomationRoutes(app, deps.automation, scope, deps.regressionCollections);
  } else {
    app.get('/api/v1/automation/assets', { config: { access: requires('automation.view') } }, async () => ({ items: [] }));
    app.get('/api/v1/automation/mappings', { config: { access: requires('automation.view') } }, async () => ({ items: [] }));
    app.post('/api/v1/automation/resolve-regression', { config: { access: requires('automation.view') } }, async () => ({
      resolved: [],
      notAutomated: [],
    }));
    app.post('/api/v1/automation/scope', { config: { access: requires('automation.view') } }, async () => ({
      caseIds: [],
      kind: 'selected',
      mode: 'selected',
    }));
  }

  app.get('/api/v1/llm/providers', { config: { access: requires('llm.view') } }, async () =>
    LlmProvidersResponse.parse({ items: deps.llm ? await deps.llm.providers() : [] }),
  );

  return app;
}
