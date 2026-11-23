import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WorkflowService, type ConnectorRepository } from '@qa/application';
import { InMemoryAuditSink, InMemoryExecutionRepository, InMemoryWorkflowRepository, InMemoryWorkflowVersionRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const DEFAULT_PROJECT = '01900000-0000-7000-8000-000000000001';
const OTHER_PROJECT = '01900000-0000-7000-8000-000000000099';
const lead = { 'x-dev-user': 'lead', 'x-dev-groups': 'QA-Platform-Leads' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
const business = { 'x-dev-user': 'biz', 'x-dev-groups': 'QA-Platform-Users' };
let app: FastifyInstance;
const spies: { mockRestore(): void }[] = [];

const connectors = {
  async get(id: string) {
    if (!['work-item', 'browser-automation', 'source-repo', 'test-management'].includes(id)) return undefined;
    return {
      id,
      projectId: DEFAULT_PROJECT,
      providerKey: 'sample',
      category: id,
      name: id,
      status: 'connected' as const,
      enabled: true,
      accessMode: 'read_only' as const,
      config: {},
      configVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  },
  async capabilityStates() {
    return ['workitem.read', 'workitem.attachment.read', 'workitem.search', 'browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.wait', 'browser.evaluate', 'browser.interact', 'browser.screenshot', 'scm.tree.list', 'scm.file.read', 'scm.code.search', 'scm.branch.list', 'tm.testcase.upsert', 'tm.testcase.read', 'tm.execution.upsert', 'tm.execution.status.update', 'tm.attachment.upload', 'tm.project.list', 'tm.suite.list', 'tm.campaign.list', 'tm.testcase.list', 'tm.tag.list', 'runner.test.execute', 'runner.test.list'].map((capability) => ({ capability, support: 'supported' as const, granted: true }));
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

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });
const listUrl = (projectId = DEFAULT_PROJECT) => `/api/v1/workflows?projectId=${projectId}`;
const createBody = (over: Record<string, unknown> = {}) => ({ projectId: DEFAULT_PROJECT, name: 'Checkout', type: 'requirement-validation', ...over });

describe('workflow drafts', () => {
  it('lets a QA lead save a draft and hides it from an engineer', async () => {
    expect((await call('POST', '/api/v1/workflows', engineer, createBody())).statusCode).toBe(403);
    expect((await call('GET', '/api/v1/workflows', lead)).statusCode).toBe(400);
    const created = await call('POST', '/api/v1/workflows', lead, createBody());
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ projectId: DEFAULT_PROJECT, key: 'checkout', status: 'draft', type: 'requirement-validation', publishedVersion: null });
    expect((await call('GET', listUrl(), lead)).json()).toMatchObject({ items: [{ name: 'Checkout', projectId: DEFAULT_PROJECT }] });
    expect((await call('GET', listUrl(), engineer)).json()).toEqual({ items: [] });
    expect((await call('GET', listUrl(OTHER_PROJECT), lead)).json()).toEqual({ items: [] });
  });

  it('lets a QA lead delete a draft freely and blocks engineers', async () => {
    const created = await call('POST', '/api/v1/workflows', lead, createBody({ name: 'Temp' }));
    const id = created.json().id as string;
    expect((await call('DELETE', `/api/v1/workflows/${id}`, engineer)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/v1/workflows/${id}`, lead)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/workflows/${id}`, lead)).statusCode).toBe(404);
  });

  it('requires projectId on create and keeps the same key free in another project', async () => {
    expect((await call('POST', '/api/v1/workflows', lead, { name: 'Checkout', type: 'requirement-validation' })).statusCode).toBe(400);
    expect((await call('POST', '/api/v1/workflows', lead, createBody())).statusCode).toBe(201);
    const other = await call('POST', '/api/v1/workflows', lead, createBody({ projectId: OTHER_PROJECT }));
    expect(other.statusCode).toBe(201);
    expect(other.json()).toMatchObject({ projectId: OTHER_PROJECT, key: 'checkout' });
  });
});

describe('publish and run', () => {
  it('refuses a broken draft, then publishes a bound template and starts a queued run', async () => {
    const empty = await call('POST', '/api/v1/workflows', lead, createBody({ name: 'Empty' }));
    expect((await call('POST', `/api/v1/workflows/${empty.json().id}/publish-request`, lead, {})).statusCode).toBe(400);

    const created = await call('POST', '/api/v1/workflows', lead, createBody({ templateKey: 'tpl-rv-ui-only' }));
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
    expect((await call('GET', listUrl(), engineer)).json()).toEqual({ items: [] });
    const published = await call('POST', `/api/v1/workflows/${id}/approve`, lead, {});
    expect(published.json()).toMatchObject({ status: 'published', publishedVersion: 1, projectId: DEFAULT_PROJECT });
    expect((await call('GET', listUrl(), business)).json().items).toHaveLength(1);
    expect((await call('GET', listUrl(OTHER_PROJECT), business)).json().items).toHaveLength(0);

    const run = await call('POST', `/api/v1/workflows/${id}/runs`, engineer, { parameters: { story: 'QA-1', environment: 'qa', applicationName: 'checkout' } });
    expect(run.statusCode).toBe(201);
    expect(run.json().status).toBe('queued');
    const history = await call('GET', '/api/v1/executions', engineer);
    expect(history.json().items[0]).toMatchObject({ id: run.json().id, workflowName: 'Checkout', status: 'queued' });
    const paused = await call('POST', `/api/v1/executions/${run.json().id}/pause`, engineer, {});
    expect(paused.json().status).toBe('paused');
    expect((await call('POST', `/api/v1/executions/${run.json().id}/pause`, engineer, {})).json().status).toBe('paused');
    const events = await call('GET', `/api/v1/executions/${run.json().id}/events`, engineer);
    expect(events.json().items.map((e: { kind: string }) => e.kind)).toContain('started');
    const stream = await call('GET', `/api/v1/executions/${run.json().id}/events/stream`, engineer);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('data:');

    const blocked = await call('DELETE', `/api/v1/workflows/${id}`, lead);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/still active/);
    expect((await call('DELETE', `/api/v1/workflows/${id}?force=true`, lead)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/workflows/${id}`, lead)).statusCode).toBe(404);
  });

  it('deletes a published workflow with no active runs without force', async () => {
    const created = await call('POST', '/api/v1/workflows', lead, createBody({ name: 'Quiet', templateKey: 'tpl-rv-ui-only' }));
    const id = created.json().id as string;
    const definition = (await call('GET', `/api/v1/workflows/${id}/definition`, lead)).json().definition;
    for (const c of definition.spec.connectors) {
      if (c.category !== 'test-runner') c.binding = { connectorInstanceId: c.category };
    }
    expect((await call('PUT', `/api/v1/workflows/${id}/definition`, lead, { definition })).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/workflows/${id}/publish-request`, lead, {})).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/workflows/${id}/approve`, lead, {})).statusCode).toBe(200);
    expect((await call('DELETE', `/api/v1/workflows/${id}`, lead)).statusCode).toBe(204);
    expect((await call('GET', `/api/v1/workflows/${id}`, lead)).statusCode).toBe(404);
  });
});
