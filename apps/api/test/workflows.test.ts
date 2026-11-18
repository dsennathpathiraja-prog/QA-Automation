import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WorkflowService } from '@qa/application';
import { InMemoryAuditSink, InMemoryWorkflowRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const lead = { 'x-dev-user': 'lead', 'x-dev-groups': 'QA-Platform-Leads' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
let app: FastifyInstance;
const spies: { mockRestore(): void }[] = [];

beforeEach(async () => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  app = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', workflows: new WorkflowService({ workflows: new InMemoryWorkflowRepository(), audit: new InMemoryAuditSink() }) });
});
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });

describe('workflow drafts', () => {
  it('lets a QA lead save a draft and hides it from an engineer', async () => {
    expect((await call('POST', '/api/v1/workflows', engineer, { name: 'Checkout', type: 'requirement-validation' })).statusCode).toBe(403);
    const created = await call('POST', '/api/v1/workflows', lead, { name: 'Checkout', type: 'requirement-validation' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: 'checkout', status: 'draft', type: 'requirement-validation' });
    expect((await call('GET', '/api/v1/workflows', lead)).json()).toMatchObject({ items: [{ name: 'Checkout' }] });
    expect((await call('GET', '/api/v1/workflows', engineer)).json()).toEqual({ items: [] });
  });
});
