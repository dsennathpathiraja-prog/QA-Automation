import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TestCaseService } from '@qa/application';
import { InMemoryAuditSink, InMemoryTestCaseRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
const business = { 'x-dev-user': 'biz', 'x-dev-groups': 'QA-Platform-Users' };
let app: FastifyInstance;
const spies: { mockRestore(): void }[] = [];

beforeEach(async () => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  app = buildApp({
    sessions: new DevHeaderSessionResolver('test'),
    profile: 'standard',
    testCases: new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() }),
  });
});
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });

describe('test case library', () => {
  it('stores a case and a new version, and a collection, without writing anywhere else', async () => {
    expect((await call('POST', '/api/v1/test-cases', business, { name: 'Login', steps: 'Open the page', expected: 'The form is shown' })).statusCode).toBe(403);
    const created = await call('POST', '/api/v1/test-cases', engineer, { name: 'Login', summary: 'A customer signs in', steps: 'Open the page', expected: 'The form is shown' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(created.json()).toMatchObject({ name: 'Login', version: 1, key: 'login' });
    const revised = await call('PUT', `/api/v1/test-cases/${id}`, engineer, { summary: 'A customer signs in', steps: 'Open the page and submit', expected: 'The account page opens' });
    expect(revised.json().version).toBe(2);
    const versions = await call('GET', `/api/v1/test-cases/${id}/versions`, business);
    expect(versions.json().items.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const collection = await call('POST', '/api/v1/test-collections', engineer, { name: 'Checkout smoke' });
    expect(collection.statusCode).toBe(201);
    const added = await call('POST', `/api/v1/test-collections/${collection.json().id}/cases`, engineer, { testCaseId: id });
    expect(added.json().cases).toEqual([{ id, name: 'Login', version: 2, position: 1, kind: 'positive', priority: 'medium' }]);
    expect((await call('GET', '/api/v1/test-cases', business)).json().items).toHaveLength(1);
    expect((await call('GET', '/api/v1/test-cases', business)).json().items[0]).toMatchObject({ kind: 'positive', priority: 'medium' });
  });

  it('keeps generated cases under the work item', async () => {
    const cases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const local = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', testCases: cases });
    const input = { name: 'Saved card is listed', steps: 'Open the page', expected: 'The card is listed', workItem: 'QA-1', summary: 'Squash 9', reference: 'QAP-qa-1-1' };
    await cases.fileUnderWorkItem({ id: 'worker' }, input);
    await cases.fileUnderWorkItem({ id: 'worker' }, { ...input, name: 'Positive: Saved card is listed', steps: 'Open the page again', expected: 'The card is still listed', kind: 'positive', priority: 'medium' });
    const board = await local.inject({ method: 'GET', url: '/api/v1/work-item-executions', headers: engineer });
    expect(board.json()).toMatchObject({ workItems: [{ workItem: 'QA-1', caseCount: 1 }], environments: [], items: [] });
    const listed = await local.inject({ method: 'GET', url: '/api/v1/test-cases', headers: engineer });
    expect(listed.json().items).toEqual([expect.objectContaining({ name: 'Positive: Saved card is listed', version: 2, summary: 'Squash 9', kind: 'positive', priority: 'medium' })]);
    const collections = await local.inject({ method: 'GET', url: '/api/v1/test-collections', headers: engineer });
    expect(collections.json().items).toEqual([expect.objectContaining({ name: 'QA-1', size: 1 })]);
    const missing = await local.inject({ method: 'POST', url: '/api/v1/work-item-executions', headers: engineer, payload: { workItem: 'QA-1', environmentId: '11111111-1111-4111-8111-111111111111' } });
    expect(missing.statusCode).toBe(400);
    await local.close();
  });

  it('resets all platform cases without touching Squash', async () => {
    const cases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const local = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', testCases: cases });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Negative: bad login', steps: 'Open', expected: 'Blocked', workItem: 'QA-1', reference: 'QAP-qa-1-1', kind: 'negative', priority: 'high' });
    expect((await local.inject({ method: 'POST', url: '/api/v1/test-cases/reset', headers: business, payload: { confirm: 'RESET_PLATFORM_CASES' } })).statusCode).toBe(403);
    expect((await local.inject({ method: 'POST', url: '/api/v1/test-cases/reset', headers: engineer, payload: { confirm: 'YES' } })).statusCode).toBe(400);
    expect((await local.inject({ method: 'POST', url: '/api/v1/test-cases/reset', headers: engineer, payload: { confirm: 'RESET_PLATFORM_CASES', wipeSquash: true } })).statusCode).toBe(400);
    const cleared = await local.inject({ method: 'POST', url: '/api/v1/test-cases/reset', headers: engineer, payload: { confirm: 'RESET_PLATFORM_CASES' } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ collectionsCleared: 1, casesCleared: 1, squashWiped: false });
    expect((await local.inject({ method: 'GET', url: '/api/v1/test-cases', headers: engineer })).json().items).toHaveLength(0);
    expect((await local.inject({ method: 'GET', url: '/api/v1/test-collections', headers: engineer })).json().items).toHaveLength(0);
    await local.close();
  });

  it('deletes a case and a collection anytime for editors', async () => {
    const cases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const local = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', testCases: cases });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Login', steps: 'Open', expected: 'Form', workItem: 'QA-1', reference: 'QAP-qa-1-1' });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Logout', steps: 'Click', expected: 'Signed out', workItem: 'QA-1', reference: 'QAP-qa-1-2' });
    expect((await local.inject({ method: 'GET', url: '/api/v1/work-item-executions', headers: engineer })).json().workItems).toEqual([
      { workItem: 'QA-1', caseCount: 2 },
    ]);
    const listed = await local.inject({ method: 'GET', url: '/api/v1/test-cases', headers: engineer });
    const caseId = listed.json().items[0].id as string;
    expect((await local.inject({ method: 'DELETE', url: `/api/v1/test-cases/${caseId}`, headers: business })).statusCode).toBe(403);
    expect((await local.inject({ method: 'DELETE', url: `/api/v1/test-cases/${caseId}`, headers: engineer })).statusCode).toBe(204);
    expect((await local.inject({ method: 'GET', url: '/api/v1/test-cases', headers: engineer })).json().items).toHaveLength(1);
    expect((await local.inject({ method: 'GET', url: '/api/v1/test-collections', headers: engineer })).json().items[0]).toMatchObject({ name: 'QA-1', size: 1 });
    expect((await local.inject({ method: 'GET', url: '/api/v1/work-item-executions', headers: engineer })).json().workItems).toEqual([
      { workItem: 'QA-1', caseCount: 1 },
    ]);
    const collectionId = (await local.inject({ method: 'GET', url: '/api/v1/test-collections', headers: engineer })).json().items[0].id as string;
    expect((await local.inject({ method: 'DELETE', url: `/api/v1/test-collections/${collectionId}`, headers: engineer })).statusCode).toBe(204);
    expect((await local.inject({ method: 'GET', url: '/api/v1/test-cases', headers: engineer })).json().items).toHaveLength(0);
    expect((await local.inject({ method: 'GET', url: '/api/v1/test-collections', headers: engineer })).json().items).toHaveLength(0);
    expect((await local.inject({ method: 'GET', url: '/api/v1/work-item-executions', headers: engineer })).json().workItems).toEqual([]);
    await local.close();
  });

  it('queues a prepared work item run', async () => {
    const repo = new InMemoryTestCaseRepository();
    const cases = new TestCaseService({ cases: repo, audit: new InMemoryAuditSink() });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Login', steps: 'Open', expected: 'Form', workItem: 'QA-1' });
    const prepared = await cases.startWorkItemExecution({ id: 'eng' }, { workItem: 'QA-1', environmentId: '11111111-1111-4111-8111-111111111111', environmentName: 'QA' });
    const local = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', testCases: cases });
    const queued = await local.inject({ method: 'POST', url: `/api/v1/work-item-executions/${prepared.id}/run`, headers: engineer, payload: {} });
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ status: 'queued', workItem: 'QA-1' });
    await local.close();
  });
});