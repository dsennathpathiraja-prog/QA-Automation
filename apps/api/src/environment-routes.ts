import type { FastifyInstance } from 'fastify';
import { CreateEnvironmentRequest, EnvironmentDetailSchema, EnvironmentListResponse, UpdateEnvironmentRequest } from '@qa/contracts';
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
}
