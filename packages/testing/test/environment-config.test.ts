import { describe, expect, it } from 'vitest';
import { EnvironmentService } from '@qa/application';
import { InMemorySecretStore } from '@qa/infrastructure';
import { InMemoryAuditSink, InMemoryEnvironmentRepository, InMemoryHostRepository } from '../src';

const actor = { id: 'trial-admin' };
const user = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada' };

function setup() {
  const environments = new InMemoryEnvironmentRepository();
  const hosts = new InMemoryHostRepository();
  const audit = new InMemoryAuditSink();
  const secrets = new InMemorySecretStore();
  const connectors = new Map<string, { id: string; name: string; category: string; enabled: boolean }>();
  const clock = { now: () => new Date('2026-06-01T00:00:00Z') };
  const service = new EnvironmentService(
    { environments, hosts, audit, secrets, secretStoreKind: 'db-envelope', users: { findBySubject: async () => user }, connectors: { get: async (id) => connectors.get(id) } },
    clock,
  );
  return { environments, hosts, audit, secrets, connectors, clock, service };
}

describe('environment configuration', () => {
  it('stores an authentication password and never returns it', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    const env = await s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    const profile = await s.service.createAuthProfile(actor, env.id, { name: 'qa-user', type: 'form-login', config: { username: 'qa.bot', loginUrl: 'https://qa.shop.example/login' }, secrets: { password: 'pw-not-shown' } });
    expect(profile).toMatchObject({ name: 'qa-user', type: 'form-login', hasSecret: true, config: { username: 'qa.bot' } });
    expect(JSON.stringify(profile)).not.toContain('pw-not-shown');
    expect(JSON.stringify(s.audit.entries)).not.toContain('pw-not-shown');
    const leased = await s.secrets.lease(`environments/${env.id}/auth/${profile.id}`);
    expect(leased.value.password).toBe('pw-not-shown');
    leased.release();
    const kept = await s.service.updateAuthProfile(actor, env.id, profile.id, { config: { username: 'qa.bot', loginUrl: 'https://qa.shop.example/login' } });
    expect(kept.hasSecret).toBe(true);
    await expect(s.service.createAuthProfile(actor, env.id, { name: 'bad', type: 'basic', config: { username: 'a', password: 'nope' } })).rejects.toThrow(/secret fields/);
  });

  it('attaches only an enabled connector of the matching kind', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    const env = await s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    s.connectors.set('c1', { id: 'c1', name: 'GitHub', category: 'source-repo', enabled: false });
    await expect(s.service.setConnectorRef(actor, env.id, { role: 'source-repo', connectorId: 'c1' })).rejects.toThrow(/Enable "GitHub"/);
    s.connectors.set('c1', { id: 'c1', name: 'GitHub', category: 'source-repo', enabled: true });
    await expect(s.service.setConnectorRef(actor, env.id, { role: 'work-item', connectorId: 'c1' })).rejects.toThrow(/source-repo/);
    const ref = await s.service.setConnectorRef(actor, env.id, { role: 'source-repo', connectorId: 'c1' });
    expect(ref.connectorName).toBe('GitHub');
  });

  it('makes production selectable only inside an authorization window', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'shop.example', purpose: 'application', internal: false, allowHttp: false });
    const env = await s.service.create(actor, { name: 'Prod', kind: 'production', applicationUrl: 'https://shop.example', restrictions: { prodSafeOnly: true, maxParallelism: 1 } });
    expect(env.selectable).toBe(false);
    const grant = await s.service.grantAuthorization(actor, env.id, { justification: 'Release check on the shop', validFrom: '2026-06-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z' });
    expect(grant).toMatchObject({ active: true, grantedByName: 'Ada' });
    expect((await s.service.get(env.id)).selectable).toBe(true);
    await expect(s.service.grantAuthorization(actor, env.id, { justification: 'A second window', validFrom: '2026-06-01T00:00:00Z', validUntil: '2026-07-01T00:00:00Z' })).rejects.toMatchObject({ errorClass: 'conflict' });
    s.clock.now = () => new Date('2027-01-01T00:00:00Z');
    expect((await s.service.get(env.id)).selectable).toBe(false);
    const validation = await s.service.validate(env.id, { workflowType: 'requirement-validation', parallelism: 4, prodSafe: false });
    expect(validation.ok).toBe(false);
    expect(validation.errors.map((e) => e.message).join(' ')).toMatch(/not authorized/);
    expect(validation.connectivity).toBe('not-run');
  });

  it('names a switched-off connector when validating a run', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    const env = await s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example', restrictions: { workflowTypes: ['regression-testing'], maxParallelism: 1, prodSafeOnly: false } });
    s.connectors.set('c1', { id: 'c1', name: 'GitHub', category: 'source-repo', enabled: true });
    await s.service.setConnectorRef(actor, env.id, { role: 'source-repo', connectorId: 'c1' });
    s.connectors.set('c1', { id: 'c1', name: 'GitHub', category: 'source-repo', enabled: false });
    const validation = await s.service.validate(env.id, { workflowType: 'requirement-validation' });
    const text = validation.errors.map((e) => e.message).join(' ');
    expect(text).toMatch(/Requirement validation is not allowed/);
    expect(text).toMatch(/GitHub/);
    const resolved = await s.service.resolve(env.id);
    expect(JSON.stringify(resolved)).not.toContain('secretLocator');
    expect(resolved.connectors).toEqual([{ role: 'source-repo', connectorId: 'c1', name: 'GitHub' }]);
  });

  it('queues a reachability check and clears it when the address changes', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    const env = await s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    expect(env.reachability).toBe('not-run');
    expect((await s.service.requestReachability(actor, env.id)).reachability).toBe('queued');
    expect((await s.service.requestReachability(actor, env.id)).reachability).toBe('queued');
    await s.environments.finishReachability(env.id, 'reachable', 'The application answered 200.', new Date('2026-06-01T00:00:00Z'));
    expect((await s.service.get(env.id)).reachabilityDetail).toBe('The application answered 200.');
    const moved = await s.service.update(actor, env.id, { applicationUrl: 'https://qa.shop.example/shop' });
    expect(moved.reachability).toBe('not-run');
    expect(moved.reachabilityDetail).toBeUndefined();
    await s.service.disable(actor, env.id);
    await expect(s.service.requestReachability(actor, env.id)).rejects.toThrow(/Enable this environment/);
  });
});
