import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { getTableName, sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_PERMISSIONS, uuidv7, type SessionRecord } from '@qa/domain';
import {
  DEFAULT_MIGRATIONS_DIR, PgAuditLog, PgExecutionRepository, PgLlmAuditSink, PgOperationLogSink, PgSessionStore, PgUserRepository, PgWorkflowRepository, PgWorkflowVersionRepository, migrate, schema, seedDefaultGroupMappings, seedRoles, type Db,
} from '../src';
import { freshDb } from './helpers';

const failure = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    const x = e as { message: string; cause?: { message?: string } };
    return `${x.cause?.message ?? ''} ${x.message}`;
  }
  throw new Error('expected the statement to fail');
};
const rows = async (db: Db, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Record<string, unknown>[] }).rows;

describe('migrations', () => {
  it('apply in order, are idempotent, and refuse a modified released migration', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as Db;
    const first = await migrate(db);
    expect(first.applied).toEqual(['0000_baseline', '0001_append_only_guards', '0002_llm_call_log', '0003_llm_call_log_append_only', '0004_connector_management', '0005_workflow_draft', '0006_workflow_engine', '0007_environment_reachability', '0008_test_case_library', '0009_test_case_work_item', '0010_squash_read_write', '0011_work_item_execution', '0012_work_item_run_results', '0013_test_case_kind_priority', '0014_work_item_live_progress', '0015_work_item_cancelled', '0016_template_preview_url', '0017_automation_assets', '0018_regression_collections', '0019_project_surface', '0020_project_surface_backfill', '0021_workflow_project_scope']);
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toHaveLength(22);

    const tmp = mkdtempSync(join(tmpdir(), 'mig-'));
    cpSync(DEFAULT_MIGRATIONS_DIR, tmp, { recursive: true });
    writeFileSync(join(tmp, '0000_baseline.sql'), `${readFileSync(join(tmp, '0000_baseline.sql'), 'utf8')}\n-- tampered`);
    await expect(migrate(db, tmp)).rejects.toThrow(/modified after it was applied/);
  });

  it('the drizzle schema matches the migrated database (no drift in table or column names)', async () => {
    const { db } = await freshDb({ seed: false });
    const dbCols = await rows(db, sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name <> 'qa_migration'`);
    const actual = new Set(dbCols.map((r) => `${r.table_name}.${r.column_name}`));
    const expected = new Set<string>();
    for (const t of Object.values(schema)) {
      if (!t || typeof t !== 'object' || !('getSQL' in (t as object))) continue;
      const cfg = getTableConfig(t as PgTable);
      for (const c of cfg.columns) expected.add(`${getTableName(t as PgTable)}.${c.name}`);
    }
    expect([...actual].filter((x) => !expected.has(x))).toEqual([]);
    expect([...expected].filter((x) => !actual.has(x))).toEqual([]);
  });
});

describe('seed', () => {
  it('mirrors the domain role/permission matrix and the four default groups, and is repeatable', async () => {
    const { db } = await freshDb();
    await seedRoles(db);
    expect(await seedDefaultGroupMappings(db)).toBe(0);
    const perms = await rows(db, sql`select r.key, count(*)::int as n from role r join role_permission p on p.role_id = r.id group by r.key`);
    for (const key of ROLES) expect(perms.find((p) => p.key === key)?.n).toBe(ROLE_PERMISSIONS[key].length);
    const maps = await rows(db, sql`select m.idp_group, r.key from idp_group_mapping m join role r on r.id = m.role_id order by m.idp_group`);
    expect(maps).toEqual([
      { idp_group: 'QA-Platform-Admins', key: 'administrator' },
      { idp_group: 'QA-Platform-Engineers', key: 'qa_engineer' },
      { idp_group: 'QA-Platform-Leads', key: 'qa_lead' },
      { idp_group: 'QA-Platform-Users', key: 'business_user' },
    ]);
  });
});

describe('database-enforced invariants', () => {
  const connector = (over: Record<string, unknown> = {}) => ({ projectId: '01900000-0000-7000-8000-000000000001', providerKey: 'github', category: 'source-repo', name: 'repo-a', accessMode: 'read_only', ...over });

  it('a source repository connector can never be read_write', async () => {
    const { db } = await freshDb();
    expect(await failure(db.insert(schema.connectorInstance).values(connector({ accessMode: 'read_write' }) as never))).toMatch(/connector_source_repo_ro_ck/);
    await db.insert(schema.connectorInstance).values(connector() as never);
    expect(await failure(db.execute(sql`update connector_instance set access_mode = 'read_write'`))).toMatch(/connector_source_repo_ro_ck/);
    await db.insert(schema.connectorInstance).values(connector({ providerKey: 'squash', category: 'test-management', name: 'tm', accessMode: 'read_write' }) as never);
  });

  it('connector names are unique among non-deleted rows; provider and category are immutable', async () => {
    const { db } = await freshDb();
    const [a] = await db.insert(schema.connectorInstance).values(connector() as never).returning({ id: schema.connectorInstance.id });
    expect(await failure(db.insert(schema.connectorInstance).values(connector() as never))).toMatch(/connector_instance_project_name_uq/);
    await db.execute(sql`update connector_instance set deleted_at = now() where id = ${a!.id}`);
    await db.insert(schema.connectorInstance).values(connector() as never);
    expect(await failure(db.execute(sql`update connector_instance set category = 'work-item' where id = ${a!.id}`))).toMatch(/immutable/);
  });

  it('allows only one active production authorization per environment', async () => {
    const { db } = await freshDb();
    const [u] = await db.insert(schema.appUser).values({ externalSubject: 's1', displayName: 'A' }).returning({ id: schema.appUser.id });
    const [env] = await db.insert(schema.environment).values({ projectId: '01900000-0000-7000-8000-000000000001', name: 'prod', kind: 'production', applicationUrl: 'https://app.example' }).returning({ id: schema.environment.id });
    const auth = { environmentId: env!.id, grantedBy: u!.id, justification: 'release', validFrom: new Date('2026-01-01'), validUntil: new Date('2026-01-02') };
    await db.insert(schema.environmentAuthorization).values(auth);
    expect(await failure(db.insert(schema.environmentAuthorization).values(auth))).toMatch(/env_auth_one_active_uq/);
    expect(await failure(db.insert(schema.environmentAuthorization).values({ ...auth, status: 'revoked', validUntil: new Date('2025-01-01') }))).toMatch(/env_auth_window_ck/);
  });

  it('http egress is only possible for internal hosts; group names are case-insensitively unique; idp roles carry no granter', async () => {
    const { db } = await freshDb();
    expect(await failure(db.insert(schema.egressAllowlist).values({ hostPattern: 'api.example.com', purpose: 'connector', internal: false, allowHttp: true }))).toMatch(/egress_http_internal_ck/);
    await db.insert(schema.egressAllowlist).values({ hostPattern: 'squash.trafforge.local', purpose: 'connector', internal: true, allowHttp: true });
    expect(await failure(db.insert(schema.egressAllowlist).values({ hostPattern: 'SQUASH.trafforge.local', purpose: 'connector', internal: true }))).toMatch(/egress_allowlist_host_uq/);
    const [r] = await db.select().from(schema.role).limit(1);
    expect(await failure(db.insert(schema.idpGroupMapping).values({ idpGroup: 'qa-platform-admins', roleId: r!.id }))).toMatch(/idp_group_mapping_group_uq/);
    const [u] = await db.insert(schema.appUser).values({ externalSubject: 's2', displayName: 'B' }).returning({ id: schema.appUser.id });
    expect(await failure(db.insert(schema.userRole).values({ userId: u!.id, roleId: r!.id, source: 'idp', grantedBy: u!.id }))).toMatch(/user_role_granted_by_ck/);
  });
});

describe('append-only tables', () => {
  const entry = { at: new Date('2026-01-01'), actorType: 'step' as const, actorId: 's', capability: 'work-item.story.get', outcome: 'success' as never, requestDigest: 'd', durationMs: 5 };

  it('reject UPDATE, DELETE and TRUNCATE on audit_log and connector_operation_log', async () => {
    const { db } = await freshDb();
    await new PgAuditLog(db).append({ at: '2026-01-01T00:00:00Z', actorId: 'u', action: 'x', subjectType: 't' });
    await new PgOperationLogSink(db).append(entry);
    for (const t of ['audit_log', 'connector_operation_log']) {
      expect(await failure(db.execute(sql.raw(`update ${t} set seq = seq`)))).toMatch(/append-only/);
      expect(await failure(db.execute(sql.raw(`delete from ${t}`)))).toMatch(/append-only/);
      expect(await failure(db.execute(sql.raw(`truncate ${t}`)))).toMatch(/append-only/);
    }
  });
});

describe('PgLlmAuditSink', () => {
  it('stores call metadata and digest, and is append-only', async () => {
    const { db } = await freshDb();
    await new PgLlmAuditSink(db).append({
      at: new Date('2026-01-01'), agentKey: 'planner', providerId: 'ollama', providerKind: 'local', model: 'qwen', dataClasses: ['story', 'code'], contextItems: 2,
      outcome: 'success', usage: { inputTokens: 10, outputTokens: 4 }, durationMs: 800, promptDigest: 'abc',
    });
    const r = await rows(db, sql`select agent_key, data_classes, input_tokens, prompt_digest from llm_call_log`);
    expect(r[0]).toEqual({ agent_key: 'planner', data_classes: ['story', 'code'], input_tokens: 10, prompt_digest: 'abc' });
    expect(await failure(db.execute(sql`delete from llm_call_log`))).toMatch(/append-only/);
    expect(await failure(db.execute(sql`truncate llm_call_log`))).toMatch(/append-only/);
  });
});

describe('PgAuditLog', () => {
  it('builds one valid chain even under concurrent writers, and detects tampering', async () => {
    const { db } = await freshDb();
    const log = new PgAuditLog(db);
    await Promise.all(Array.from({ length: 12 }, (_, i) => log.append({ at: new Date(1_700_000_000_000 + i).toISOString(), actorId: `u${i}`, action: 'test', subjectType: 'x', detail: { i } })));
    expect(await log.verify(5)).toEqual({ ok: true, entries: 12 });
    expect((await log.recent(3)).map((e) => e.seq)).toEqual([12, 11, 10]);

    await db.execute(sql`alter table audit_log disable trigger audit_log_append_only`);
    await db.execute(sql`update audit_log set action = 'forged' where seq = 7`);
    expect(await log.verify(5)).toEqual({ ok: false, brokenAtSeq: 7 });
  });
});

describe('PgSessionStore', () => {
  const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    id: 'tok-abcdefghijklmnop', userId: 'u1', displayName: 'Dasun', groups: ['QA-Platform-Leads'], roles: ['qa_lead'], csrfToken: 'c', idToken: 'idt',
    idpSessionId: 'sid-1', createdAt: 1_000, lastSeenAt: 1_000, expiresAt: 9_000_000_000_000, ...over,
  });

  it('round-trips records, never stores the raw token, and supports touch and the three delete modes', async () => {
    const { db } = await freshDb();
    const s = new PgSessionStore(db);
    await s.create(rec());
    expect(await s.get('tok-abcdefghijklmnop')).toEqual(rec());
    expect(await s.get('other')).toBeUndefined();
    const raw = await rows(db, sql`select token_hash from app_session`);
    expect(raw[0]!.token_hash).not.toContain('tok-abcdefghijklmnop');
    expect(raw[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    await s.touch('tok-abcdefghijklmnop', 5_000);
    expect((await s.get('tok-abcdefghijklmnop'))!.lastSeenAt).toBe(5_000);

    await s.create(rec({ id: 'tok-2', idpSessionId: 'sid-1' }));
    await s.create(rec({ id: 'tok-3', idpSessionId: 'sid-2', userId: 'u2' }));
    expect(await s.deleteByIdpSession('sid-1')).toBe(2);
    expect(await s.deleteByUser('u2')).toBe(1);
    await s.create(rec({ id: 'tok-4', expiresAt: 100 }));
    expect(await s.purgeExpired(200)).toBe(1);
    await s.create(rec({ id: 'tok-5' }));
    await s.delete('tok-5');
    expect(await s.get('tok-5')).toBeUndefined();
  });
});

describe('PgUserRepository', () => {
  it('provisions users at login and mirrors IdP roles without touching manual grants', async () => {
    const { db } = await freshDb();
    const repo = new PgUserRepository(db);
    const first = await repo.recordLogin({ subject: 'kc-1', displayName: 'Dasun', email: 'd@example.org', roles: ['qa_lead', 'qa_engineer'] });
    expect(first.created).toBe(true);
    const [mgr] = await db.select().from(schema.role).where(sql`key = 'administrator'`);
    await db.insert(schema.userRole).values({ userId: first.userId, roleId: mgr!.id, source: 'manual', grantedBy: first.userId });

    const second = await repo.recordLogin({ subject: 'kc-1', displayName: 'Dasun P', roles: ['qa_engineer'] });
    expect(second).toEqual({ userId: first.userId, created: false });
    const granted = await rows(db, sql`select r.key, ur.source from user_role ur join role r on r.id = ur.role_id where ur.user_id = ${first.userId} order by r.key`);
    expect(granted).toEqual([{ key: 'administrator', source: 'manual' }, { key: 'qa_engineer', source: 'idp' }]);
    const u = await rows(db, sql`select display_name, row_version from app_user where id = ${first.userId}`);
    expect(u[0]).toMatchObject({ display_name: 'Dasun P', row_version: 2 });
    await db.execute(sql`update app_user set status = 'disabled' where id = ${first.userId}`);
    expect(await repo.isDisabled('kc-1')).toBe(true);
    expect(await repo.isDisabled('nobody')).toBe(false);
  });
});

describe('workflow engine storage', () => {
  it('keeps a published version immutable and records a side effect once', async () => {
    const { db } = await freshDb();
    const workflows = new PgWorkflowRepository(db);
    const versions = new PgWorkflowVersionRepository(db);
    const runs = new PgExecutionRepository(db);
    const wf = await workflows.insert({ id: uuidv7(), projectId: '01900000-0000-7000-8000-000000000001', key: 'demo', name: 'Demo', description: '', type: 'requirement-validation', definition: { spec: { steps: [{ id: 'a' }] } } });
    const version = await versions.insert({ id: uuidv7(), workflowId: wf.id, version: 1, contentHash: 'abc', definition: wf.definition, approvedBy: 'lead' });
    expect(await failure(db.update(schema.workflowVersion).set({ contentHash: 'changed' }).where(sql`id = ${version.id}`))).toMatch(/not allowed/);
    const run = await runs.insert({ id: uuidv7(), workflowId: wf.id, versionId: version.id, definition: { spec: { steps: [{ id: 'a' }, { id: 'b' }] } }, params: {} });
    const now = new Date('2026-11-18T12:00:00Z');
    const claimed = await runs.claim('w1', now, 30_000);
    expect(claimed?.id).toBe(run.id);
    expect(await runs.recordEffect(run.id, 'a', 'a')).toBe('new');
    expect(await runs.claim('w2', now, 30_000)).toBeUndefined();
    const resumed = await runs.claim('w2', new Date(now.getTime() + 31_000), 30_000);
    expect(resumed?.stepIndex).toBe(0);
    expect(await runs.recordEffect(run.id, 'a', 'a')).toBe('exists');
  });
});

describe('uuidv7', () => {
  it('is version 7, time-ordered and unique', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 50 }, () => uuidv7())).size).toBe(50);
  });
});
