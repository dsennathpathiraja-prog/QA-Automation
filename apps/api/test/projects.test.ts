import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ProjectService } from '@qa/application';
import { InMemoryAuditSink, InMemoryProjectRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const admin = { 'x-dev-user': 'root', 'x-dev-groups': 'QA-Platform-Admins' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
const business = { 'x-dev-user': 'biz', 'x-dev-groups': 'QA-Platform-Users' };

let app: FastifyInstance;
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  const service = new ProjectService({ projects: new InMemoryProjectRepository(), audit: new InMemoryAuditSink() });
  app = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', projects: service });
});

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string> = {}, payload?: object) =>
  app.inject({ method, url, headers, payload });

describe('project routes', () => {
  it('lets viewers list and managers create', async () => {
    expect((await call('GET', '/api/v1/projects', business)).statusCode).toBe(200);
    expect((await call('POST', '/api/v1/projects', engineer, { name: 'Shop' })).statusCode).toBe(403);
    const created = await call('POST', '/api/v1/projects', admin, { name: 'Shop', description: 'Demo' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'Shop', key: 'shop', status: 'active' });
    expect((await call('GET', '/api/v1/projects', engineer)).json().items).toEqual([expect.objectContaining({ name: 'Shop' })]);
  });
});
