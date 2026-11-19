import type { FastifyInstance } from 'fastify';
import {
  AddCollectionCaseRequest, CreateTestCaseRequest, CreateTestCollectionRequest, ResetTestCasesRequest, ResetTestCasesResponse, ReviseTestCaseRequest, StartWorkItemExecutionRequest, TestCaseListResponse, TestCaseSchema, TestCaseVersionList, TestCollectionListResponse, TestCollectionSchema, WorkItemCaseScreenshot, WorkItemExecutionBoard, WorkItemExecutionSchema,
} from '@qa/contracts';
import { PlatformError } from '@qa/domain';
import type { EnvironmentService, TestCaseService } from '@qa/application';
import { requires } from '@qa/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new PlatformError('validation', `The ${what} request is not valid.`);
  return r.data;
};

const idOf = (raw: unknown, what: string) => {
  const id = String(raw);
  if (!UUID.test(id)) throw new PlatformError('not-found', `${what} not found`);
  return id;
};

export function registerTestCaseRoutes(app: FastifyInstance, cases: TestCaseService, environments?: EnvironmentService) {
  app.get('/api/v1/test-cases', { config: { access: requires('testcase.view') } }, async () => TestCaseListResponse.parse({ items: await cases.list() }));

  app.post('/api/v1/test-cases', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    const created = await cases.create({ id: req.principal!.id }, body(CreateTestCaseRequest, req.body, 'create test case'));
    return reply.code(201).send(TestCaseSchema.parse(created));
  });

  /** Soft-clears every platform collection and case. Squash is never wiped here. */
  app.post('/api/v1/test-cases/reset', { config: { access: requires('testcase.edit') } }, async (req) => {
    const input = body(ResetTestCasesRequest, req.body, 'reset test cases');
    return ResetTestCasesResponse.parse(await cases.resetPlatform({ id: req.principal!.id }, input));
  });

  app.get('/api/v1/test-cases/:id', { config: { access: requires('testcase.view') } }, async (req) => TestCaseSchema.parse(await cases.get(idOf((req.params as { id: string }).id, 'Test case'))));

  app.get('/api/v1/test-cases/:id/versions', { config: { access: requires('testcase.view') } }, async (req) => TestCaseVersionList.parse({ items: await cases.versions(idOf((req.params as { id: string }).id, 'Test case')) }));

  app.put('/api/v1/test-cases/:id', { config: { access: requires('testcase.edit') } }, async (req) => {
    const saved = await cases.revise({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Test case'), body(ReviseTestCaseRequest, req.body, 'revise test case'));
    return TestCaseSchema.parse(saved);
  });

  app.delete('/api/v1/test-cases/:id', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    await cases.remove({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Test case'));
    return reply.code(204).send();
  });

  app.get('/api/v1/test-collections', { config: { access: requires('testcase.view') } }, async () => TestCollectionListResponse.parse({ items: await cases.collections() }));

  app.post('/api/v1/test-collections', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    const created = await cases.createCollection({ id: req.principal!.id }, body(CreateTestCollectionRequest, req.body, 'create collection'));
    return reply.code(201).send(TestCollectionSchema.parse({ ...created, cases: [] }));
  });

  app.get('/api/v1/test-collections/:id', { config: { access: requires('testcase.view') } }, async (req) => TestCollectionSchema.parse(await cases.collection(idOf((req.params as { id: string }).id, 'Collection'))));

  app.delete('/api/v1/test-collections/:id', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    await cases.removeCollection({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Collection'));
    return reply.code(204).send();
  });

  app.post('/api/v1/test-collections/:id/cases', { config: { access: requires('testcase.edit') } }, async (req) => {
    const input = body(AddCollectionCaseRequest, req.body, 'add test case');
    return TestCollectionSchema.parse(await cases.addToCollection({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Collection'), idOf(input.testCaseId, 'Test case')));
  });

  app.delete('/api/v1/test-collections/:id/cases/:caseId', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    const params = req.params as { id: string; caseId: string };
    await cases.removeFromCollection({ id: req.principal!.id }, idOf(params.id, 'Collection'), idOf(params.caseId, 'Test case'));
    return reply.code(204).send();
  });

  app.get('/api/v1/work-item-executions', { config: { access: requires('execution.start') } }, async () => {
    const board = await cases.executionBoard();
    const listed = environments ? (await environments.list()).filter((item) => item.enabled && item.selectable) : [];
    return WorkItemExecutionBoard.parse({ ...board, environments: listed.map((item) => ({ id: item.id, name: item.name, kind: item.kind })) });
  });

  app.post('/api/v1/work-item-executions', { config: { access: requires('execution.start') } }, async (req, reply) => {
    const input = body(StartWorkItemExecutionRequest, req.body, 'start work item execution');
    if (!environments) throw new PlatformError('validation', 'No environments are configured.');
    const env = await environments.get(input.environmentId);
    if (!env.enabled || !env.selectable) throw new PlatformError('validation', 'That environment cannot be used.');
    const created = await cases.startWorkItemExecution({ id: req.principal!.id }, { workItem: input.workItem, environmentId: env.id, environmentName: env.name });
    return reply.code(201).send(WorkItemExecutionSchema.parse(created));
  });

  app.get('/api/v1/work-item-executions/:id', { config: { access: requires('execution.start') } }, async (req) => {
    return WorkItemExecutionSchema.parse(await cases.getWorkItemExecution(idOf((req.params as { id: string }).id, 'Work item execution')));
  });

  app.post('/api/v1/work-item-executions/:id/run', { config: { access: requires('execution.start') } }, async (req) => {
    return WorkItemExecutionSchema.parse(await cases.queueWorkItemExecution({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Work item execution')));
  });

  app.get('/api/v1/work-item-executions/:id/cases/:caseId/screenshot', { config: { access: requires('execution.start') } }, async (req) => {
    const params = req.params as { id: string; caseId: string };
    return WorkItemCaseScreenshot.parse(await cases.caseScreenshot(idOf(params.id, 'Work item execution'), idOf(params.caseId, 'Test case')));
  });
}
