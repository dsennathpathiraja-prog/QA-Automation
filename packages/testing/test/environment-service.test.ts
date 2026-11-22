import { describe, expect, it } from 'vitest';
import { EnvironmentService } from '@qa/application';
import { InMemoryAuditSink, InMemoryEnvironmentRepository, InMemoryHostRepository } from '../src';

const actor = { id: 'admin' };

function setup() {
  const environments = new InMemoryEnvironmentRepository();
  const hosts = new InMemoryHostRepository();
  const audit = new InMemoryAuditSink();
  const service = new EnvironmentService({ environments, hosts, audit });
  return { environments, hosts, audit, service };
}

describe('environments', () => {
  it('creates a selectable QA environment when the application host is approved', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    const created = await s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example/shop' });
    expect(created).toMatchObject({ name: 'QA', kind: 'qa', selectable: true, enabled: true, browser: { browser: 'chromium', headless: true }, restrictions: { maxParallelism: 1, prodSafeOnly: false } });
    expect(created.applicationUrl).toBe('https://qa.shop.example/shop');
    expect(s.audit.entries.map((e) => e.action)).toEqual(['environment.create']);
  });

  it('names the host that still needs approving', async () => {
    const s = setup();
    await expect(s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' })).rejects.toMatchObject({
      errorClass: 'validation',
      message: expect.stringContaining('qa.shop.example'),
    });
  });

  it('refuses plain http unless the host is an approved internal host', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    await expect(s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'http://qa.shop.example' })).rejects.toThrow(/Plain http is not allowed/);
    await s.hosts.add({ hostPattern: 'shop.internal', purpose: 'application', internal: true, allowHttp: true });
    const created = await s.service.create(actor, { name: 'Lab', kind: 'development', applicationUrl: 'http://shop.internal' });
    expect(created.selectable).toBe(true);
  });

  it('stores production but does not make it selectable, and requires the prod-safe restriction', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'shop.example', purpose: 'application', internal: false, allowHttp: false });
    await expect(s.service.create(actor, { name: 'Prod', kind: 'production', applicationUrl: 'https://shop.example', restrictions: { prodSafeOnly: false } })).rejects.toThrow(/prod-safe/);
    const created = await s.service.create(actor, { name: 'Prod', kind: 'production', applicationUrl: 'https://shop.example', restrictions: { prodSafeOnly: true, maxParallelism: 1 } });
    expect(created.selectable).toBe(false);
    s.environments.authorizations.push({ id: 'a', environmentId: created.id, status: 'active', validFrom: new Date(Date.now() - 1_000), validUntil: new Date(Date.now() + 86_400_000) });
    expect((await s.service.get(created.id)).selectable).toBe(true);
  });

  it('rejects a duplicate name and removal of an enabled environment', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    const created = await s.service.create(actor, { name: 'QA', kind: 'qa', applicationUrl: 'https://qa.shop.example' });
    await expect(s.service.create(actor, { name: 'qa', kind: 'qa', applicationUrl: 'https://qa.shop.example' })).rejects.toMatchObject({ errorClass: 'conflict' });
    await expect(s.service.remove(actor, created.id)).rejects.toThrow(/Disable this environment/);
    await s.service.disable(actor, created.id);
    await s.service.remove(actor, created.id);
    await expect(s.service.get(created.id)).rejects.toMatchObject({ errorClass: 'not-found' });
  });

  it('stores and clears an optional template preview URL on the same approved host rules', async () => {
    const s = setup();
    await s.hosts.add({ hostPattern: 'qa.shop.example', purpose: 'application', internal: false, allowHttp: false });
    await s.hosts.add({ hostPattern: 'email-preview-fixture', purpose: 'application', internal: true, allowHttp: true });
    const created = await s.service.create(actor, {
      name: 'QA',
      kind: 'qa',
      applicationUrl: 'https://qa.shop.example/shop',
      templatePreviewUrl: 'http://email-preview-fixture/',
    });
    expect(created.templatePreviewUrl).toBe('http://email-preview-fixture/');
    const cleared = await s.service.update(actor, created.id, { templatePreviewUrl: '' });
    expect(cleared.templatePreviewUrl).toBeUndefined();
  });
});
