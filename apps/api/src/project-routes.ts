import type { FastifyInstance } from 'fastify';
import {
  CreateProjectRequest,
  ProjectListResponse,
  ProjectSummarySchema,
  UpdateProjectRequest,
} from '@qa/contracts';
import { PlatformError } from '@qa/domain';
import type { ProjectService } from '@qa/application';
import { requires } from '@qa/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new PlatformError('validation', `The ${what} request is not valid.`);
  return r.data;
};

const idOf = (raw: unknown): string => {
  const id = String(raw);
  if (!UUID.test(id)) throw new PlatformError('not-found', 'Project not found');
  return id;
};

export function registerProjectRoutes(app: FastifyInstance, projects: ProjectService) {
  app.get('/api/v1/projects', { config: { access: requires('project.view') } }, async (req) => {
    const q = req.query as { status?: string };
    const status = q.status === 'active' || q.status === 'archived' ? q.status : undefined;
    return ProjectListResponse.parse({ items: await projects.list(status ? { status } : undefined) });
  });

  app.post('/api/v1/projects', { config: { access: requires('project.manage') } }, async (req, reply) => {
    const input = body(CreateProjectRequest, req.body, 'create project');
    const created = await projects.create({ id: req.principal!.id }, input);
    return reply.code(201).send(ProjectSummarySchema.parse(created));
  });

  app.get('/api/v1/projects/:id', { config: { access: requires('project.view') } }, async (req) =>
    ProjectSummarySchema.parse(await projects.get(idOf((req.params as { id: string }).id))),
  );

  app.patch('/api/v1/projects/:id', { config: { access: requires('project.manage') } }, async (req) => {
    const input = body(UpdateProjectRequest, req.body, 'update project');
    return ProjectSummarySchema.parse(await projects.update({ id: req.principal!.id }, idOf((req.params as { id: string }).id), input));
  });

  app.post('/api/v1/projects/:id/archive', { config: { access: requires('project.manage') } }, async (req) =>
    ProjectSummarySchema.parse(await projects.archive({ id: req.principal!.id }, idOf((req.params as { id: string }).id))),
  );
}
