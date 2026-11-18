import type { FastifyInstance } from 'fastify';
import { CreateWorkflowRequest, UpdateWorkflowRequest, WorkflowListResponse, WorkflowSchema } from '@qa/contracts';
import { PlatformError, isRole, permissionsForRoles } from '@qa/domain';
import type { WorkflowService } from '@qa/application';
import { requires } from '@qa/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new PlatformError('validation', `The ${what} request is not valid.`);
  return r.data;
};

const drafts = (roles: readonly string[]) => {
  const p = permissionsForRoles(roles.filter(isRole));
  return p.has('workflow.create') || p.has('workflow.edit');
};

export function registerWorkflowRoutes(app: FastifyInstance, workflows: WorkflowService) {
  app.get('/api/v1/workflows', { config: { access: requires('workflow.view_published') } }, async (req) => {
    const include = drafts(req.principal!.roles);
    return WorkflowListResponse.parse({ items: await workflows.list(include) });
  });

  app.post('/api/v1/workflows', { config: { access: requires('workflow.create') } }, async (req, reply) => {
    const created = await workflows.create({ id: req.principal!.id }, body(CreateWorkflowRequest, req.body, 'create workflow'));
    return reply.code(201).send(WorkflowSchema.parse(created));
  });

  app.get('/api/v1/workflows/:id', { config: { access: requires('workflow.view_published') } }, async (req) => {
    const id = String((req.params as { id: string }).id);
    if (!UUID.test(id)) throw new PlatformError('not-found', 'Workflow not found');
    return WorkflowSchema.parse(await workflows.get(id, drafts(req.principal!.roles)));
  });

  app.patch('/api/v1/workflows/:id', { config: { access: requires('workflow.edit') } }, async (req) => {
    const id = String((req.params as { id: string }).id);
    if (!UUID.test(id)) throw new PlatformError('not-found', 'Workflow not found');
    return WorkflowSchema.parse(await workflows.update({ id: req.principal!.id }, id, body(UpdateWorkflowRequest, req.body, 'update workflow')));
  });
}
