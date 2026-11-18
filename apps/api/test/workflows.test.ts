import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WorkflowService, type ConnectorRepository } from '@qa/application';
import { InMemoryAuditSink, InMemoryExecutionRepository, InMemoryWorkflowRepository, InMemoryWorkflowVersionRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const lead = { 'x-dev-user': 'lead', 'x-dev-groups': 'QA-Platform-Leads' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
const business = { 'x-dev-user': 'biz', 'x-dev-groups': 'QA-Platform-Users' };
let app: FastifyInstance;
const spies: { mockRestore(): void }[] = [];

const connectors = {
  async get(id: string) {
    if (!['work-item', 'browser-automation', 'source-repo', 'test-management'].includes(id)) return undefined;
    return { id, providerKey: 'sample', category: id, name: id, status: 'connected' as const, enabled: true, accessMode: 'read_only' as const, config: {}, configVersion: 1, createdAt: new Date(), updatedAt: new Date() };
  },
  async capabilityStates() {
    return ['workitem.read', 'workitem.attachment.read', 'workitem.search', 'browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.interact', 'browser.screenshot', 'scm.tree.list', 'scm.file.read', 'scm.code.search', 'scm.branch.list', 'tm.testcase.upsert', 'tm.testcase.read', 'tm.execution.upsert', 'tm.execution.status.update', 'tm.attachment.upload', 'tm.project.list', 'tm.suite.list', 'tm.campaign.list', 'tm.testcase.list', 'tm.tag.list', 'runner.test.execute', 'runner.test.list'].map((capability) => ({ capability, support: 'supported' as const, granted: true }));
  },
} as unknown as ConnectorRepository;

beforeEach(async () => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  app = buildApp({
    sessions: new DevHeaderSessionResolver('test'),
    profile: 'standard',
    workflows: new WorkflowService({ workflows: new InMemoryWorkflowRepository(), versions: new InMemoryWorkflowVersionRepository(), executions: new InMemoryExecutionRepository(), connectors, audit: new InMemoryAuditSink() }),
  });
});
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });

describe('workflow drafts', () => {
  it('lets a QA lead save a draft and hides it from an engineer', async () => {
    expect((await call('POST', '/api/v1/workflows', engineer, { name: 'Checkout', type: 'requirement-validation' })).statusCode).toBe(403);
    const created = await call('POST', '/api/v1/workflows', lead, { name: 'Checkout', type: 'requirement-validation' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ key: 'checkout', status: 'draft', type: 'requirement-validation', publishedVersion: null });
    expect((await call('GET', '/api/v1/workflows', lead)).json()).toMatchObject({ items: [{ name: 'Checkout' }] });
    expect((await call('GET', '/api/v1/workflows', engineer)).json()).toEqual({ items: [] });
  });
});

describe('publish and run', () => {
  it('refuses a broken draft, then publishes a bound template and starts a queued run', async () => {
    const empty = await call('POST', '/api/v1/workflows', lead, { name: 'Empty', type: 'requirement-validation' });
    expect((await call('POST', `/api/v1/workflows/${empty.json().id}/publish-request`, lead, {})).statusCode).toBe(400);

    const created = await call('POST', '/api/v1/workflows', lead, { name: 'Checkout', type: 'requirement-validation', templateKey: 'tpl-rv-ui-only' });
    const id = created.json().id as string;
    const definition = (await call('GET', `/api/v1/workflows/${id}/definition`, lead)).json().definition;
    for (const c of definition.spec.connectors) {
      if (c.category !== 'test-runner') c.binding = { connectorInstanceId: c.category };
    }
    expect((await call('PUT', `/api/v1/workflows/${id}/definition`, lead, { definition })).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/workflows/${id}/publish-request`, engineer, {})).statusCode).toBe(403);
    const review = await call('POST', `/api/v1/workflows/${id}/publish-request`, lead, {});
    expect(review.statusCode).toBe(200);
    expect(review.json().status).toBe('in_review');
    expect((await call('GET', '/api/v1/workflows', engineer)).json()).toEqual({ items: [] });
    const published = await call('POST', `/api/v1/workflows/${id}/approve`, lead, {});
    expect(published.json()).toMatchObject({ status: 'published', publishedVersion: 1 });
    expect((await call('GET', '/api/v1/workflows', business)).json().items).toHaveLength(1);

    const run = await call('POST', `/api/v1/workflows/${id}/runs`, engineer, { parameters: { story: 'QA-1', environment: 'qa', applicationName: 'checkout' } });
    expect(run.statusCode).toBe(201);
    expect(run.json().status).toBe('queued');
    const paused = await call('POST', `/api/v1/executions/${run.json().id}/pause`, engineer, {});
    expect(paused.json().status).toBe('paused');
    expect((await call('POST', `/api/v1/executions/${run.json().id}/pause`, engineer, {})).json().status).toBe('paused');
    const events = await call('GET', `/api/v1/executions/${run.json().id}/events`, engineer);
    expect(events.json().items.map((e: { kind: string }) => e.kind)).toContain('started');
    const stream = await call('GET', `/api/v1/executions/${run.json().id}/events/stream`, engineer);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('data:');
  });
});
