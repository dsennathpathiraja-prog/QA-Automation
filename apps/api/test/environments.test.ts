import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EnvironmentService } from '@qa/application';
import { InMemoryAuditSink, InMemoryEnvironmentRepository, InMemoryHostRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const admin = { 'x-dev-user': 'root', 'x-dev-groups': 'QA-Platform-Admins' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
const business = { 'x-dev-user': 'biz', 'x-dev-groups': 'QA-Platform-Users' };

let app: FastifyInstance;
const spies: { mockRestore(): void }[] = [];

beforeEach(async () => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  const hosts = new InMemoryHostRepository();
  await hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
  const service = new EnvironmentService({ environments: new InMemoryEnvironmentRepository(), hosts, audit: new InMemoryAuditSink() });
  app = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', environments: service });
});

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, headers: Record<string, string> = {}, payload?: object) =>
  app.inject({ method, url, headers, payload });

describe('environment routes', () => {
  it('lets an administrator create an environment and hides management from other roles', async () => {
    expect((await call('GET', '/api/v1/environments', business)).statusCode).toBe(403);
    expect((await call('POST', '/api/v1/environments', engineer, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' })).statusCode).toBe(403);
    const created = await call('POST', '/api/v1/environments', admin, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.selectable).toBe(true);
    expect((await call('GET', '/api/v1/environments', engineer)).json()).toMatchObject({ items: [{ name: 'QA' }] });
  });
});
