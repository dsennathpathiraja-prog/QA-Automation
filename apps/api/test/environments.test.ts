import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { EnvironmentService } from '@qa/application';
import { InMemorySecretStore } from '@qa/infrastructure';
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
  const service = new EnvironmentService({
    environments: new InMemoryEnvironmentRepository(),
    hosts,
    audit: new InMemoryAuditSink(),
    secrets: new InMemorySecretStore(),
    secretStoreKind: 'db-envelope',
    users: { findBySubject: async () => ({ id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada' }) },
    connectors: { get: async () => undefined },
  });
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

  it('accepts a password and answers without it', async () => {
    const created = await call('POST', '/api/v1/environments', admin, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    const id = created.json().id as string;
    const profile = await call('POST', `/api/v1/environments/${id}/auth-profiles`, admin, { name: 'qa-user', type: 'basic', config: { username: 'qa.bot' }, secrets: { password: 'pw-not-shown' } });
    expect(profile.statusCode).toBe(201);
    expect(JSON.stringify(profile.json())).not.toContain('pw-not-shown');
    expect(profile.json()).toMatchObject({ hasSecret: true, config: { username: 'qa.bot' } });
    expect((await call('POST', `/api/v1/environments/${id}/auth-profiles`, engineer, { name: 'other', type: 'none' })).statusCode).toBe(403);
  });

  it('queues a reachability check for an administrator', async () => {
    const created = await call('POST', '/api/v1/environments', admin, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    const id = created.json().id as string;
    expect((await call('POST', `/api/v1/environments/${id}/reachability`, engineer)).statusCode).toBe(403);
    const queued = await call('POST', `/api/v1/environments/${id}/reachability`, admin);
    expect(queued.statusCode).toBe(200);
    expect(queued.json()).toMatchObject({ reachability: 'queued' });
  });
});
