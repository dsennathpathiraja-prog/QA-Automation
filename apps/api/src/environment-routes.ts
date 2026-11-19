import type { FastifyInstance } from 'fastify';
import {
  AuthProfileListResponse,
  AuthProfileRequest,
  AuthProfileSchema,
  AuthorizationListResponse,
  AuthorizationSchema,
  ConnectorRefListResponse,
  ConnectorRefSchema,
  CreateEnvironmentRequest,
  EnvironmentDetailSchema,
  EnvironmentListResponse,
  EnvironmentValidationSchema,
  GrantAuthorizationRequest,
  ResolvedEnvironmentSchema,
  SetConnectorRefRequest,
  TestDataListResponse,
  TestDataProfileSchema,
  TestDataRequest,
  UpdateEnvironmentRequest,
  ValidateEnvironmentRequest,
} from '@qa/contracts';
import { PlatformError } from '@qa/domain';
import type { EnvironmentService } from '@qa/application';
import { requires } from '@qa/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new PlatformError('validation', `The ${what} request is not valid.`);
  return r.data;
};

const idOf = (raw: unknown): string => {
  const id = String(raw);
  if (!UUID.test(id)) throw new PlatformError('not-found', 'Environment not found');
  return id;
};

export function registerEnvironmentRoutes(app: FastifyInstance, environments: EnvironmentService) {
  app.get('/api/v1/environments', { config: { access: requires('environment.view') } }, async () => EnvironmentListResponse.parse({ items: await environments.list() }));

  app.post('/api/v1/environments', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    const input = body(CreateEnvironmentRequest, req.body, 'create environment');
    const created = await environments.create({ id: req.principal!.id }, input);
    return reply.code(201).send(EnvironmentDetailSchema.parse(created));
  });

  app.get('/api/v1/environments/:id', { config: { access: requires('environment.view') } }, async (req) => EnvironmentDetailSchema.parse(await environments.get(idOf((req.params as { id: string }).id))));

  app.patch('/api/v1/environments/:id', { config: { access: requires('environment.manage') } }, async (req) => {
    const input = body(UpdateEnvironmentRequest, req.body, 'update environment');
    return EnvironmentDetailSchema.parse(await environments.update({ id: req.principal!.id }, idOf((req.params as { id: string }).id), input));
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/api/v1/environments/:id/${action}`, { config: { access: requires('environment.manage') } }, async (req) =>
      EnvironmentDetailSchema.parse(await environments[action]({ id: req.principal!.id }, idOf((req.params as { id: string }).id))),
    );
  }

  app.delete('/api/v1/environments/:id', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    await environments.remove({ id: req.principal!.id }, idOf((req.params as { id: string }).id));
    return reply.code(204).send();
  });

  app.post('/api/v1/environments/:id/reachability', { config: { access: requires('environment.manage') } }, async (req) =>
    EnvironmentDetailSchema.parse(await environments.requestReachability({ id: req.principal!.id }, idOf((req.params as { id: string }).id))),
  );

  const envId = (req: { params: unknown }) => idOf((req.params as { id: string }).id);
  const childId = (req: { params: unknown }) => idOf((req.params as { profileId: string }).profileId);

  app.get('/api/v1/environments/:id/auth-profiles', { config: { access: requires('environment.view') } }, async (req) => AuthProfileListResponse.parse({ items: await environments.listAuthProfiles(envId(req)) }));
  app.post('/api/v1/environments/:id/auth-profiles', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    const created = await environments.createAuthProfile({ id: req.principal!.id }, envId(req), body(AuthProfileRequest, req.body, 'authentication profile'));
    return reply.code(201).send(AuthProfileSchema.parse(created));
  });
  app.patch('/api/v1/environments/:id/auth-profiles/:profileId', { config: { access: requires('environment.manage') } }, async (req) => AuthProfileSchema.parse(await environments.updateAuthProfile({ id: req.principal!.id }, envId(req), childId(req), body(AuthProfileRequest.partial(), req.body, 'authentication profile'))));
  app.delete('/api/v1/environments/:id/auth-profiles/:profileId', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    await environments.deleteAuthProfile({ id: req.principal!.id }, envId(req), childId(req));
    return reply.code(204).send();
  });

  app.get('/api/v1/environments/:id/test-data', { config: { access: requires('environment.view') } }, async (req) => TestDataListResponse.parse({ items: await environments.listTestData(envId(req)) }));
  app.post('/api/v1/environments/:id/test-data', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    const created = await environments.createTestData({ id: req.principal!.id }, envId(req), body(TestDataRequest, req.body, 'test data profile'));
    return reply.code(201).send(TestDataProfileSchema.parse(created));
  });
  app.patch('/api/v1/environments/:id/test-data/:profileId', { config: { access: requires('environment.manage') } }, async (req) => TestDataProfileSchema.parse(await environments.updateTestData({ id: req.principal!.id }, envId(req), childId(req), body(TestDataRequest.partial(), req.body, 'test data profile'))));
  app.delete('/api/v1/environments/:id/test-data/:profileId', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    await environments.deleteTestData({ id: req.principal!.id }, envId(req), childId(req));
    return reply.code(204).send();
  });

  app.get('/api/v1/environments/:id/connectors', { config: { access: requires('environment.view') } }, async (req) => ConnectorRefListResponse.parse({ items: await environments.listConnectorRefs(envId(req)) }));
  app.put('/api/v1/environments/:id/connectors', { config: { access: requires('environment.manage') } }, async (req) => ConnectorRefSchema.parse(await environments.setConnectorRef({ id: req.principal!.id }, envId(req), body(SetConnectorRefRequest, req.body, 'connector reference'))));
  app.delete('/api/v1/environments/:id/connectors/:role', { config: { access: requires('environment.manage') } }, async (req, reply) => {
    await environments.removeConnectorRef({ id: req.principal!.id }, envId(req), String((req.params as { role: string }).role));
    return reply.code(204).send();
  });

  app.get('/api/v1/environments/:id/authorizations', { config: { access: requires('environment.view') } }, async (req) => AuthorizationListResponse.parse({ items: await environments.listAuthorizations(envId(req)) }));
  app.post('/api/v1/environments/:id/authorizations', { config: { access: requires('environment.production.authorize') } }, async (req, reply) => {
    const created = await environments.grantAuthorization({ id: req.principal!.id }, envId(req), body(GrantAuthorizationRequest, req.body, 'production authorization'));
    return reply.code(201).send(AuthorizationSchema.parse(created));
  });
  app.post('/api/v1/environments/:id/authorizations/:profileId/revoke', { config: { access: requires('environment.production.authorize') } }, async (req) => AuthorizationSchema.parse(await environments.revokeAuthorization({ id: req.principal!.id }, envId(req), childId(req))));

  app.get('/api/v1/environments/:id/resolved', { config: { access: requires('environment.view') } }, async (req) => ResolvedEnvironmentSchema.parse(await environments.resolve(envId(req))));
  app.post('/api/v1/environments/:id/validate', { config: { access: requires('environment.view') } }, async (req) => EnvironmentValidationSchema.parse(await environments.validate(envId(req), body(ValidateEnvironmentRequest, req.body ?? {}, 'validation'))));
}
