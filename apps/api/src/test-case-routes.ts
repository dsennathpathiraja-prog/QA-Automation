import type { FastifyInstance } from 'fastify';
import {
  AddCollectionCaseRequest, CreateTestCaseRequest, CreateTestCollectionRequest, ReviseTestCaseRequest, TestCaseListResponse, TestCaseSchema, TestCaseVersionList, TestCollectionListResponse, TestCollectionSchema,
} from '@qa/contracts';
import { PlatformError } from '@qa/domain';
import type { TestCaseService } from '@qa/application';
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

export function registerTestCaseRoutes(app: FastifyInstance, cases: TestCaseService) {
  app.get('/api/v1/test-cases', { config: { access: requires('testcase.view') } }, async () => TestCaseListResponse.parse({ items: await cases.list() }));

  app.post('/api/v1/test-cases', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    const created = await cases.create({ id: req.principal!.id }, body(CreateTestCaseRequest, req.body, 'create test case'));
    return reply.code(201).send(TestCaseSchema.parse(created));
  });

  app.get('/api/v1/test-cases/:id', { config: { access: requires('testcase.view') } }, async (req) => TestCaseSchema.parse(await cases.get(idOf((req.params as { id: string }).id, 'Test case'))));

  app.get('/api/v1/test-cases/:id/versions', { config: { access: requires('testcase.view') } }, async (req) => TestCaseVersionList.parse({ items: await cases.versions(idOf((req.params as { id: string }).id, 'Test case')) }));

  app.put('/api/v1/test-cases/:id', { config: { access: requires('testcase.edit') } }, async (req) => {
    const saved = await cases.revise({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Test case'), body(ReviseTestCaseRequest, req.body, 'revise test case'));
    return TestCaseSchema.parse(saved);
  });

  app.get('/api/v1/test-collections', { config: { access: requires('testcase.view') } }, async () => TestCollectionListResponse.parse({ items: await cases.collections() }));

  app.post('/api/v1/test-collections', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    const created = await cases.createCollection({ id: req.principal!.id }, body(CreateTestCollectionRequest, req.body, 'create collection'));
    return reply.code(201).send(TestCollectionSchema.parse({ ...created, cases: [] }));
  });

  app.get('/api/v1/test-collections/:id', { config: { access: requires('testcase.view') } }, async (req) => TestCollectionSchema.parse(await cases.collection(idOf((req.params as { id: string }).id, 'Collection'))));

  app.post('/api/v1/test-collections/:id/cases', { config: { access: requires('testcase.edit') } }, async (req) => {
    const input = body(AddCollectionCaseRequest, req.body, 'add test case');
    return TestCollectionSchema.parse(await cases.addToCollection({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Collection'), idOf(input.testCaseId, 'Test case')));
  });

  app.delete('/api/v1/test-collections/:id/cases/:caseId', { config: { access: requires('testcase.edit') } }, async (req, reply) => {
    const params = req.params as { id: string; caseId: string };
    await cases.removeFromCollection({ id: req.principal!.id }, idOf(params.id, 'Collection'), idOf(params.caseId, 'Test case'));
    return reply.code(204).send();
  });
}
