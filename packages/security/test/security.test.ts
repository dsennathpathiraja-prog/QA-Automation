import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUP_MAPPINGS, PolicyEngine, SecretRedactor, chainEntry, mapGroupsToRoles, verifyChain, type AuditEntry, type Principal } from '../src';

const user = (id: string, roles: Principal['roles']): Principal => ({ id, displayName: id, roles });
const engine = new PolicyEngine();

describe('PolicyEngine', () => {
  it('denies without permission and allows with it', () => {
    expect(engine.can(user('a', ['business_user']), 'connector.manage').allow).toBe(false);
    expect(engine.can(user('a', ['administrator']), 'connector.manage').allow).toBe(true);
  });

  it('enforces maker-checker on publication approval', () => {
    const lead = user('lead1', ['qa_lead']);
    expect(engine.can(lead, 'workflow.publish.approve', { resource: { authorId: 'lead1' } }).allow).toBe(false);
    expect(engine.can(lead, 'workflow.publish.approve', { resource: { authorId: 'someone' } }).allow).toBe(true);
  });

  it('enforces the two-person rule for production approval', () => {
    const lead = user('lead1', ['qa_lead']);
    expect(engine.can(lead, 'execution.approve.production', { resource: { requesterId: 'lead1' } }).allow).toBe(false);
    expect(engine.can(lead, 'execution.approve.production', { resource: { requesterId: 'eng1' } }).allow).toBe(true);
  });

  it('requires environment authorization and workflow allowance to request a production run', () => {
    const lead = user('lead1', ['qa_lead']);
    expect(engine.can(lead, 'execution.start.production', { resource: { productionAuthorized: false, productionAllowedByWorkflow: true } }).allow).toBe(false);
    expect(engine.can(lead, 'execution.start.production', { resource: { productionAuthorized: true, productionAllowedByWorkflow: false } }).allow).toBe(false);
    expect(engine.can(lead, 'execution.start.production', { resource: { productionAuthorized: true, productionAllowedByWorkflow: true } }).allow).toBe(true);
    expect(engine.can(user('eng', ['qa_engineer']), 'execution.start.production', { resource: { productionAuthorized: true, productionAllowedByWorkflow: true } }).allow).toBe(false);
  });

  it('limits business users to business-runnable workflows', () => {
    const biz = user('b', ['business_user']);
    expect(engine.can(biz, 'execution.start', { resource: { businessRunnable: false } }).allow).toBe(false);
    expect(engine.can(biz, 'execution.start', { resource: { businessRunnable: true } }).allow).toBe(true);
    expect(engine.can(user('e', ['qa_engineer']), 'execution.start').allow).toBe(true);
  });

  it('lets owners control their runs and execution.control.any control all', () => {
    expect(engine.canControlExecution(user('u1', ['qa_engineer']), 'u1').allow).toBe(true);
    expect(engine.canControlExecution(user('u1', ['qa_engineer']), 'u2').allow).toBe(false);
    expect(engine.canControlExecution(user('l', ['qa_lead']), 'u2').allow).toBe(true);
  });
});

describe('group to role mapping', () => {
  it('maps the four default groups', () => {
    for (const [g, r] of [['QA-Platform-Admins', 'administrator'], ['QA-Platform-Leads', 'qa_lead'], ['QA-Platform-Engineers', 'qa_engineer'], ['QA-Platform-Users', 'business_user']] as const) {
      expect(mapGroupsToRoles([g], { mappings: DEFAULT_GROUP_MAPPINGS }).roles).toEqual([r]);
    }
  });

  it('is the union of roles and reports unmapped groups', () => {
    const r = mapGroupsToRoles(['QA-Platform-Users', 'QA-Platform-Engineers', 'Other'], { mappings: DEFAULT_GROUP_MAPPINGS });
    expect(new Set(r.roles)).toEqual(new Set(['business_user', 'qa_engineer']));
    expect(r.unmappedGroups).toEqual(['Other']);
  });

  it('gives no access when no group maps', () => {
    expect(mapGroupsToRoles(['Random'], { mappings: DEFAULT_GROUP_MAPPINGS }).authorized).toBe(false);
    expect(mapGroupsToRoles(undefined, { mappings: DEFAULT_GROUP_MAPPINGS }).authorized).toBe(false);
  });

  it('supports Keycloak path format and case-insensitive matching', () => {
    expect(mapGroupsToRoles(['/org/qa-platform-leads'], { mappings: DEFAULT_GROUP_MAPPINGS, groupFormat: 'path' }).roles).toEqual(['qa_lead']);
  });

  it('supports object-id style mappings and ignores disabled rows', () => {
    const mappings = [{ idpGroup: '11111111-2222', role: 'administrator' as const }, { idpGroup: 'x', role: 'qa_lead' as const, enabled: false }];
    expect(mapGroupsToRoles(['11111111-2222', 'x'], { mappings, groupFormat: 'object-id' }).roles).toEqual(['administrator']);
  });
});

describe('SecretRedactor', () => {
  it('redacts registered values and token shapes in nested data', () => {
    const r = new SecretRedactor();
    r.register({ token: 'super-secret-value-123' });
    const out = r.redact({ a: 'x super-secret-value-123 y', b: ['Bearer abcdefghijklmnopqrstuvwxyz', { c: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123' }] });
    expect(JSON.stringify(out)).not.toMatch(/super-secret-value-123|abcdefghijklmnopqrstuvwxyz/);
    expect(JSON.stringify(out)).toContain('[REDACTED]');
  });

  it('does not mangle values containing regex characters', () => {
    const r = new SecretRedactor();
    r.register({ pw: 'a.b*c(d)[e]+' });
    expect(r.redactString('pw=a.b*c(d)[e]+;')).toBe('pw=[REDACTED];');
  });
});

describe('audit hash chain', () => {
  const mk = (): AuditEntry[] => {
    const out: AuditEntry[] = [];
    for (let i = 0; i < 3; i += 1) out.push(chainEntry(out.at(-1), { at: `2026-01-0${i + 1}`, actorId: 'u', action: `a${i}`, subjectType: 't', detail: { i } }));
    return out;
  };

  it('verifies an intact chain', () => {
    expect(verifyChain(mk()).ok).toBe(true);
  });

  it('detects tampering, deletion and reordering', () => {
    const e = mk();
    expect(verifyChain([e[0]!, { ...e[1]!, action: 'tampered' }, e[2]!])).toEqual({ ok: false, brokenAtSeq: 2 });
    expect(verifyChain([e[0]!, e[2]!]).ok).toBe(false);
    expect(verifyChain([e[1]!, e[0]!, e[2]!]).ok).toBe(false);
  });
});
