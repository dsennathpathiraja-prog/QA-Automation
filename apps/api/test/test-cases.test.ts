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
    expect(added.json().cases).toEqual([{ id, name: 'Login', version: 2, position: 1 }]);
    expect((await call('GET', '/api/v1/test-cases', business)).json().items).toHaveLength(1);
  });
});