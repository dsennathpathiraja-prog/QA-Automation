import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLE_PERMISSIONS, permissionsForRoles } from '../src';

describe('role permission matrix', () => {
  it('administrator holds every permission', () => {
    expect(new Set(ROLE_PERMISSIONS.administrator)).toEqual(new Set(PERMISSIONS));
  });

  it('only administrators manage connectors, environments, users, agents and models', () => {
    for (const p of ['connector.manage', 'environment.manage', 'user.manage', 'agent.configure', 'llm.manage', 'environment.production.authorize'] as const) {
      expect(permissionsForRoles(['qa_lead']).has(p)).toBe(false);
      expect(permissionsForRoles(['qa_engineer']).has(p)).toBe(false);
      expect(permissionsForRoles(['business_user']).has(p)).toBe(false);
    }
  });

  it('QA lead can approve publication and automation; QA engineer cannot', () => {
    expect(permissionsForRoles(['qa_lead']).has('workflow.publish.approve')).toBe(true);
    expect(permissionsForRoles(['qa_lead']).has('automation.approve')).toBe(true);
    expect(permissionsForRoles(['qa_engineer']).has('workflow.publish.approve')).toBe(false);
    expect(permissionsForRoles(['qa_engineer']).has('automation.approve')).toBe(false);
  });

  it('business users cannot see connectors, create workflows or approve production', () => {
    const p = permissionsForRoles(['business_user']);
    expect(p.has('connector.view_status')).toBe(false);
    expect(p.has('workflow.create')).toBe(false);
    expect(p.has('execution.approve.production')).toBe(false);
    expect(p.has('execution.start')).toBe(true);
  });

  it('multiple roles produce the union', () => {
    const p = permissionsForRoles(['business_user', 'qa_engineer']);
    expect(p.has('automation.register')).toBe(true);
  });
});
