import type { FastifyInstance } from 'fastify';
import {
  ApproveHostRequest,
  ApprovedHostListResponse,
  ConnectorDetailSchema,
  ConnectorListResponse,
  CreateConnectorRequest,
  OperationLogResponse,
  ProviderListResponse,
  ReplaceCredentialsRequest,
  TestRequestResponse,
  UpdateConnectorRequest,
} from '@qa/contracts';
import { PlatformError } from '@qa/domain';
import type { ConnectorService, OperationLogReader } from '@qa/application';
import { PolicyEngine, requires } from '@qa/security';

export interface ConnectorRouteDeps {
  connectors: ConnectorService;
  operations: OperationLogReader;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T => {
  const r = schema.safeParse(raw);
  // Never echo the submitted body: it may contain credentials.
  if (!r.success) throw new PlatformError('validation', `The ${what} request is not valid.`);
  return r.data;
};

const idOf = (raw: unknown): string => {
  const id = String(raw);
  if (!UUID.test(id)) throw new PlatformError('not-found', 'Connector not found');
  return id;
};

export function registerConnectorRoutes(app: FastifyInstance, deps: ConnectorRouteDeps, policy: PolicyEngine) {
  const svc = deps.connectors;
  const canManage = (req: { principal?: Parameters<PolicyEngine['can']>[0] }) => policy.can(req.principal!, 'connector.manage').allow;

  app.get('/api/v1/connector-providers', { config: { access: requires('connector.view_status') } }, async () => ProviderListResponse.parse({ items: svc.providers() }));

  app.get('/api/v1/connectors', { config: { access: requires('connector.view_status') } }, async () => ConnectorListResponse.parse({ items: await svc.list() }));

  app.post('/api/v1/connectors', { config: { access: requires('connector.manage') } }, async (req, reply) => {
    const input = body(CreateConnectorRequest, req.body, 'create connector');
    const created = await svc.create({ id: req.principal!.id }, input);
    return reply.code(201).send(ConnectorDetailSchema.parse(created));
  });

  app.get('/api/v1/connectors/:id', { config: { access: requires('connector.view_status') } }, async (req) => {
    const d = await svc.get(idOf((req.params as { id: string }).id), { includeConfig: canManage(req) });
    return ConnectorDetailSchema.parse(d);
  });

  app.patch('/api/v1/connectors/:id', { config: { access: requires('connector.manage') } }, async (req) => {
    const input = body(UpdateConnectorRequest, req.body, 'update connector');
    return ConnectorDetailSchema.parse(await svc.update({ id: req.principal!.id }, idOf((req.params as { id: string }).id), input));
  });

  app.put('/api/v1/connectors/:id/credentials', { config: { access: requires('connector.manage') } }, async (req) => {
    const input = body(ReplaceCredentialsRequest, req.body, 'replace credentials');
    return ConnectorDetailSchema.parse(await svc.replaceCredentials({ id: req.principal!.id }, idOf((req.params as { id: string }).id), input.secrets));
  });

  app.post('/api/v1/connectors/:id/test', { config: { access: requires('connector.manage') } }, async (req, reply) => {
    const r = await svc.requestTest({ id: req.principal!.id }, idOf((req.params as { id: string }).id));
    return reply.code(202).send(TestRequestResponse.parse({ id: r.id, status: r.status, requestedAt: r.requestedAt.toISOString() }));
  });

  for (const action of ['enable', 'disable', 'disconnect'] as const) {
    app.post(`/api/v1/connectors/:id/${action}`, { config: { access: requires('connector.manage') } }, async (req) =>
      ConnectorDetailSchema.parse(await svc[action]({ id: req.principal!.id }, idOf((req.params as { id: string }).id))),
    );
  }

  app.delete('/api/v1/connectors/:id', { config: { access: requires('connector.manage') } }, async (req, reply) => {
    await svc.remove({ id: req.principal!.id }, idOf((req.params as { id: string }).id));
    return reply.code(204).send();
  });

  app.get('/api/v1/connectors/:id/operations', { config: { access: requires('audit.read') } }, async (req) => {
    const id = idOf((req.params as { id: string }).id);
    const q = req.query as { outcome?: string; before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const before = q.before && /^\d+$/.test(q.before) ? Number(q.before) : undefined;
    const rows = await deps.operations.list({ connectorInstanceId: id, outcome: q.outcome, beforeSeq: before, limit: limit + 1 });
    const page = rows.slice(0, limit);
    return OperationLogResponse.parse({
      items: page.map((r) => ({ ...r, at: r.at.toISOString() })),
      nextBeforeSeq: rows.length > limit ? page.at(-1)?.seq : undefined,
    });
  });

  app.get('/api/v1/egress/hosts', { config: { access: requires('connector.manage') } }, async () =>
    ApprovedHostListResponse.parse({ items: (await svc.listHosts()).map((h) => ({ ...h, approvedAt: h.approvedAt.toISOString() })) }),
  );

  app.post('/api/v1/egress/hosts', { config: { access: requires('security.policy.manage') } }, async (req, reply) => {
    const input = body(ApproveHostRequest, req.body, 'approve host');
    const h = await svc.approveHost({ id: req.principal!.id }, input);
    return reply.code(201).send({ id: h.id, hostPattern: h.hostPattern, internal: h.internal, allowHttp: h.allowHttp, approvedAt: h.approvedAt.toISOString() });
  });

  app.delete('/api/v1/egress/hosts/:id', { config: { access: requires('security.policy.manage') } }, async (req, reply) => {
    await svc.removeHost({ id: req.principal!.id }, String((req.params as { id: string }).id));
    return reply.code(204).send();
  });
}
