import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectorStorageContract } from '@qa/testing';
import { PgApprovedHostRepository, PgAuditLog, PgConnectorRepository, PgSessionStore, PgTestRequestQueue, connectPostgres, migrate, pingDb, seedDefaultGroupMappings, seedRoles, type PgConnection } from '../src';

/**
 * Runs only when TEST_DATABASE_URL points at a server where the user may CREATE DATABASE, e.g.
 *   TEST_DATABASE_URL=postgres://qa_test:qa_test@127.0.0.1:5432/postgres pnpm test
 * Covers what the in-process engine cannot: multiple real connections, cross-connection advisory locks, the pg driver.
 */
const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('PostgreSQL (real server)', () => {
  const name = `qa_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let conn: PgConnection;
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const u = new URL(url!);
    u.pathname = `/${name}`;
    conn = connectPostgres({ url: u.toString(), max: 8 });
  });

  afterAll(async () => {
    await conn?.close();
    await admin?.query(`drop database if exists ${name} with (force)`);
    await admin?.end();
  });

  it('serialises concurrent migrators from separate connections', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => migrate(conn.db)));
    expect(results.flatMap((r) => r.applied).sort()).toEqual(['0000_baseline', '0001_append_only_guards', '0002_llm_call_log', '0003_llm_call_log_append_only', '0004_connector_management']);
    await seedRoles(conn.db);
    await seedDefaultGroupMappings(conn.db);
    expect(await pingDb(conn.db)).toBe(true);
  });

  it('keeps the audit chain linear with concurrent writers on different connections', async () => {
    const log = new PgAuditLog(conn.db);
    await Promise.all(Array.from({ length: 30 }, (_, i) => log.append({ at: new Date(1_700_000_000_000 + i).toISOString(), actorId: `u${i % 4}`, action: 'load', subjectType: 'x' })));
    expect(await log.verify(7)).toEqual({ ok: true, entries: 30 });
  });

  it('enforces append-only triggers and stores sessions through the pg driver', async () => {
    await expect(conn.db.execute(sql`update audit_log set action = 'x'`)).rejects.toThrow();
    const s = new PgSessionStore(conn.db);
    await s.create({ id: 'tok-real-driver-1', userId: 'u', displayName: 'U', groups: ['g'], roles: ['qa_lead'], csrfToken: 'c', idToken: 't', createdAt: 1000, lastSeenAt: 1000, expiresAt: 9_000_000_000_000 });
    expect((await s.get('tok-real-driver-1'))?.roles).toEqual(['qa_lead']);
  });

  it('hands each queued connector test to exactly one of several concurrent workers', async () => {
    const connectors = new PgConnectorRepository(conn.db);
    const tests = new PgTestRequestQueue(conn.db);
    const ids = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const id = crypto.randomUUID();
        await connectors.insert({ id, providerKey: 'sample-work-items', category: 'work-item', name: `Concurrent ${i}`, config: {}, accessMode: 'read_only' });
        await tests.enqueue(id, 1, 'u');
        return id;
      }),
    );
    const claimed = (await Promise.all(Array.from({ length: 30 }, () => tests.claimNext()))).filter((r) => r !== undefined);
    expect(claimed.map((r) => r!.connectorId).sort()).toEqual([...ids].sort());
  });

  connectorStorageContract('real postgres', async () => {
    for (const t of ['connector_test_request', 'connector_capability_state', 'connector_health_check', 'connector_instance', 'egress_allowlist']) await conn.db.execute(sql.raw(`delete from ${t}`));
    return { connectors: new PgConnectorRepository(conn.db), tests: new PgTestRequestQueue(conn.db), hosts: new PgApprovedHostRepository(conn.db) };
  });
});
