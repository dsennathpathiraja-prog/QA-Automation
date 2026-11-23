import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConnectorService, connectorSecretLocator } from '@qa/application';
import { ConnectorExecutionManager, ProviderRegistry, createDefaultCapabilityRegistry } from '@qa/connector-sdk';
import { InMemorySecretStore, sampleProvider } from '@qa/infrastructure';
import { SecretRedactor } from '@qa/security';
import { StaticPolicyStore, execPolicy } from '@qa/testing';
import { PgApprovedHostRepository, PgAuditLog, PgAuditSink, PgConnectorRepository, PgInstanceResolver, PgOperationLogReader, PgOperationLogSink, PgTestRequestQueue } from '../src';
import { freshDb } from './helpers';

const actor = { id: randomUUID() };
const actorRef = { type: 'step' as const, id: 'read_items', executionId: 'ex1', stepId: 's1' };

async function setup() {
  const { db } = await freshDb();
  const capabilities = createDefaultCapabilityRegistry();
  const providers = new ProviderRegistry(capabilities);
  providers.register(sampleProvider);
  const secrets = new InMemorySecretStore();
  const connectors = new PgConnectorRepository(db);
  const audit = new PgAuditLog(db);
  const service = new ConnectorService({ connectors, tests: new PgTestRequestQueue(db), secrets, providers, capabilities, hosts: new PgApprovedHostRepository(db), audit: new PgAuditSink(audit) });
  const log = new PgOperationLogSink(db);
  const manager = (id: string) =>
    new ConnectorExecutionManager({
      capabilities,
      providers,
      instances: new PgInstanceResolver(db, (l) => secrets.exists(l)),
      policies: new StaticPolicyStore(new Map([['ex1', execPolicy({ boundRoles: { workItems: id } })]])),
      secrets,
      log,
      redactor: new SecretRedactor(),
      adapterDeps: { http: { request: async () => Promise.reject(new Error('no network in this test')) } },
    });
  const created = await service.create(actor, { projectId: '01900000-0000-7000-8000-000000000001', providerKey: 'sample-work-items', name: 'Demo source', config: { projectName: 'Retail Web' }, secrets: { demoKey: 'demo-key-for-test' } });
  const invoke = () => manager(created.id).invoke<{ items: { id: string }[] }>({ role: 'workItems', capability: 'workitem.project.list', input: {}, actor: actorRef });
  const grantAll = async () => {
    await connectors.replaceCapabilityStates(created.id, [{ capability: 'workitem.project.list', support: 'supported', granted: true }]);
    await connectors.update(created.id, { status: 'connected' });
  };
  return { db, service, connectors, secrets, created, invoke, grantAll, audit, log: new PgOperationLogReader(db) };
}

describe('connector instances in Postgres feed the Connector Execution Manager', () => {
  it('denies use of a draft, disabled, or ungranted connector, and allows an enabled, granted one', async () => {
    const t = await setup();
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'denied', message: expect.stringMatching(/disabled/) });

    await t.grantAll();
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'denied', message: expect.stringMatching(/disabled/) });

    await t.service.enable(actor, t.created.id);
    await expect(t.invoke()).resolves.toMatchObject({ items: [{ id: 'demo' }] });

    await t.service.disable(actor, t.created.id);
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'denied' });

    // newest first
    const rows = await t.log.list({ connectorInstanceId: t.created.id, limit: 10 });
    expect(rows.map((r) => r.outcome)).toEqual(['denied', 'ok', 'denied', 'denied']);
    expect(rows[1]).toMatchObject({ capability: 'workitem.project.list', access: 'read', actorId: 'read_items' });
    expect(await t.log.list({ outcome: 'ok', limit: 10 })).toHaveLength(1);
    expect(await t.log.list({ connectorInstanceId: t.created.id, beforeSeq: rows[1]!.seq, limit: 10 })).toHaveLength(2);
  });

  it('stops serving a connector once it is changed, disconnected or removed', async () => {
    const t = await setup();
    await t.grantAll();
    await t.service.enable(actor, t.created.id);
    await t.invoke();

    await t.service.update(actor, t.created.id, { config: { projectName: 'Changed' } });
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'denied' });

    await t.grantAll();
    await t.service.enable(actor, t.created.id);
    await t.invoke();
    await t.service.disconnect(actor, t.created.id);
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'denied' });

    await t.service.remove(actor, t.created.id);
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'not-found' });
  });

  it('does not grant capabilities the last probe marked unsupported', async () => {
    const t = await setup();
    await t.connectors.replaceCapabilityStates(t.created.id, [{ capability: 'workitem.project.list', support: 'unsupported', granted: false }]);
    await t.connectors.update(t.created.id, { status: 'connected' });
    await t.service.enable(actor, t.created.id);
    await expect(t.invoke()).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('writes a verifiable audit trail without any credential value', async () => {
    const t = await setup();
    await t.service.replaceCredentials(actor, t.created.id, { demoKey: 'demo-rotated-key-xyz' });
    expect(await t.audit.verify()).toMatchObject({ ok: true, entries: 2 });
    const text = JSON.stringify(await t.audit.recent());
    expect(text).not.toContain('demo-key-for-test');
    expect(text).not.toContain('demo-rotated-key-xyz');
    expect(await t.secrets.exists(connectorSecretLocator(t.created.id))).toBe(true);
  });
});
