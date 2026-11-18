import type { FastifyInstance } from 'fastify';
import {
  CreateWorkflowRequest, ExecutionEventList, ExecutionListResponse, ExecutionSchema, SaveWorkflowDefinitionRequest, StartRunRequest, UpdateWorkflowRequest, ValidationReportSchema, WorkflowDefinitionResponse, WorkflowListResponse, WorkflowSchema, WorkflowTemplateList,
} from '@qa/contracts';
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

const idOf = (req: { params: unknown }) => {
  const id = String((req.params as { id: string }).id);
  if (!UUID.test(id)) throw new PlatformError('not-found', 'Workflow not found');
  return id;
};

export function registerWorkflowRoutes(app: FastifyInstance, workflows: WorkflowService) {
  app.get('/api/v1/workflow-templates', { config: { access: requires('workflow.create') } }, async () => WorkflowTemplateList.parse({ items: workflows.templates() }));

  app.get('/api/v1/workflows', { config: { access: requires('workflow.view_published') } }, async (req) => {
    return WorkflowListResponse.parse({ items: await workflows.list(drafts(req.principal!.roles)) });
  });

  app.post('/api/v1/workflows', { config: { access: requires('workflow.create') } }, async (req, reply) => {
    const created = await workflows.create({ id: req.principal!.id }, body(CreateWorkflowRequest, req.body, 'create workflow'));
    return reply.code(201).send(WorkflowSchema.parse(created));
  });

  app.get('/api/v1/workflows/:id', { config: { access: requires('workflow.view_published') } }, async (req) => {
    return WorkflowSchema.parse(await workflows.get(idOf(req), drafts(req.principal!.roles)));
  });

  app.patch('/api/v1/workflows/:id', { config: { access: requires('workflow.edit') } }, async (req) => {
    return WorkflowSchema.parse(await workflows.update({ id: req.principal!.id }, idOf(req), body(UpdateWorkflowRequest, req.body, 'update workflow')));
  });

  app.get('/api/v1/workflows/:id/definition', { config: { access: requires('workflow.view_published') } }, async (req) => {
    return WorkflowDefinitionResponse.parse({ definition: await workflows.definition(idOf(req), drafts(req.principal!.roles)) });
  });

  app.put('/api/v1/workflows/:id/definition', { config: { access: requires('workflow.edit') } }, async (req) => {
    const saved = await workflows.saveDefinition({ id: req.principal!.id }, idOf(req), body(SaveWorkflowDefinitionRequest, req.body, 'save workflow').definition);
    return WorkflowSchema.parse(saved);
  });

  app.post('/api/v1/workflows/:id/validate', { config: { access: requires('workflow.edit') } }, async (req) => {
    return ValidationReportSchema.parse({ issues: await workflows.validate(idOf(req), true) });
  });

  app.post('/api/v1/workflows/:id/publish-request', { config: { access: requires('workflow.publish.request') } }, async (req) => {
    return WorkflowSchema.parse(await workflows.requestPublish({ id: req.principal!.id }, idOf(req)));
  });

  app.post('/api/v1/workflows/:id/approve', { config: { access: requires('workflow.publish.approve') } }, async (req) => {
    return WorkflowSchema.parse(await workflows.approve({ id: req.principal!.id }, idOf(req)));
  });

  app.post('/api/v1/workflows/:id/duplicate', { config: { access: requires('workflow.create') } }, async (req, reply) => {
    return reply.code(201).send(WorkflowSchema.parse(await workflows.duplicate({ id: req.principal!.id }, idOf(req))));
  });

  app.post('/api/v1/workflows/:id/disable', { config: { access: requires('workflow.edit') } }, async (req) => {
    return WorkflowSchema.parse(await workflows.disable({ id: req.principal!.id }, idOf(req)));
  });

  app.post('/api/v1/workflows/:id/runs', { config: { access: requires('execution.start') } }, async (req, reply) => {
    const input = body(StartRunRequest, req.body ?? {}, 'start workflow');
    return reply.code(201).send(ExecutionSchema.parse(await workflows.start({ id: req.principal!.id }, idOf(req), input.parameters ?? {})));
  });

  app.get('/api/v1/workflows/:id/runs', { config: { access: requires('execution.start') } }, async (req) => {
    return ExecutionListResponse.parse({ items: await workflows.runs(idOf(req)) });
  });

  app.get('/api/v1/executions/:id', { config: { access: requires('execution.start') } }, async (req) => {
    return ExecutionSchema.parse(await workflows.run(idOf(req)));
  });

  app.get('/api/v1/executions/:id/events', { config: { access: requires('execution.start') } }, async (req) => {
    return ExecutionEventList.parse({ items: await workflows.events(idOf(req)) });
  });

  app.get('/api/v1/executions/:id/events/stream', { config: { access: requires('execution.start') } }, async (req, reply) => {
    const events = await workflows.events(idOf(req));
    const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') || ': empty\n\n';
    return reply.type('text/event-stream').send(payload);
  });

  app.post('/api/v1/executions/:id/pause', { config: { access: requires('execution.control') } }, async (req) => ExecutionSchema.parse(await workflows.control({ id: req.principal!.id }, idOf(req), 'pause')));
  app.post('/api/v1/executions/:id/resume', { config: { access: requires('execution.control') } }, async (req) => ExecutionSchema.parse(await workflows.control({ id: req.principal!.id }, idOf(req), 'resume')));
  app.post('/api/v1/executions/:id/cancel', { config: { access: requires('execution.control') } }, async (req) => ExecutionSchema.parse(await workflows.control({ id: req.principal!.id }, idOf(req), 'cancel')));
}
