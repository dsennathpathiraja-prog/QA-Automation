import { describe, expect, it } from 'vitest';
import { buildApp, DevHeaderSessionResolver } from '../src';
import { publicRoute } from '@qa/security';

const app = () => buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard' });
const as = (user: string, groups: string) => ({ 'x-dev-user': user, 'x-dev-groups': groups });

describe('api guard', () => {
  it('serves public health without auth', async () => {
    const res = await app().inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', profile: 'standard' });
  });

  it('401 without a session, 403 without the permission', async () => {
    const a = app();
    expect((await a.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/v1/connectors', headers: as('u', 'QA-Platform-Users') })).statusCode).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/api/v1/connectors', headers: as('u', 'QA-Platform-Engineers') })).statusCode).toBe(200);
  });

  it('403 bodies are generic and leak nothing', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/v1/identity/mappings', headers: as('u', 'QA-Platform-Leads') });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { class: 'denied', message: 'Forbidden' } });
  });

  it('maps groups to roles and exposes effective permissions', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/v1/me', headers: as('dasun', 'QA-Platform-Leads') });
    const body = res.json();
    expect(body.roles).toEqual(['qa_lead']);
    expect(body.permissions).toContain('workflow.publish.approve');
    expect(body.permissions).not.toContain('connector.manage');
  });

  it('authenticated users with no mapped group see no permissions and cannot reach guarded routes', async () => {
    const a = app();
    const me = (await a.inject({ method: 'GET', url: '/api/v1/me', headers: as('x', 'Unrelated') })).json();
    expect(me.roles).toEqual([]);
    expect(me.permissions).toEqual([]);
    expect((await a.inject({ method: 'GET', url: '/api/v1/connectors', headers: as('x', 'Unrelated') })).statusCode).toBe(403);
  });

  it('administrators can read identity mappings', async () => {
    const res = await app().inject({ method: 'GET', url: '/api/v1/identity/mappings', headers: as('root', 'QA-Platform-Admins') });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(4);
  });

  it('refuses to register a route that does not declare access', async () => {
    const a = app();
    expect(() => a.get('/oops', async () => 'x')).toThrow(/must declare config.access/);
    expect(() => a.get('/fine', { config: { access: publicRoute } }, async () => 'x')).not.toThrow();
  });

  it('dev header auth cannot be constructed in production', () => {
    expect(() => new DevHeaderSessionResolver('production')).toThrow(/production/);
  });

  it('readiness reflects dependency checks', async () => {
    const a = buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard', readiness: { db: async () => false, bao: async () => true } });
    const res = await a.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().failing).toEqual(['db']);
  });
});
