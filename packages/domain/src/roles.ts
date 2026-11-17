export const ROLES = ['administrator', 'qa_lead', 'qa_engineer', 'business_user'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'connector.manage',
  'connector.view_status',
  'environment.manage',
  'environment.view',
  'environment.pick',
  'environment.production.authorize',
  'workflow.create',
  'workflow.edit',
  'workflow.publish.request',
  'workflow.publish.approve',
  'workflow.view_published',
  'execution.start',
  'execution.start.production',
  'execution.control',
  'execution.control.any',
  'execution.approve.production',
  'testcase.view',
  'testcase.select_scope',
  'automation.view',
  'automation.register',
  'automation.approve',
  'evidence.view',
  'report.view',
  'agent.view',
  'agent.configure',
  'llm.view',
  'llm.manage',
  'user.manage',
  'role.assign',
  'security.policy.manage',
  'audit.read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  administrator: ALL,
  qa_lead: [
    'connector.view_status',
    'environment.view',
    'environment.pick',
    'workflow.create',
    'workflow.edit',
    'workflow.publish.request',
    'workflow.publish.approve',
    'workflow.view_published',
    'execution.start',
    'execution.start.production',
    'execution.control',
    'execution.control.any',
    'execution.approve.production',
    'testcase.view',
    'testcase.select_scope',
    'automation.view',
    'automation.register',
    'automation.approve',
    'evidence.view',
    'report.view',
    'agent.view',
    'llm.view',
    'audit.read',
  ],
  qa_engineer: [
    'connector.view_status',
    'environment.view',
    'environment.pick',
    'workflow.view_published',
    'execution.start',
    'execution.control',
    'testcase.view',
    'testcase.select_scope',
    'automation.view',
    'automation.register',
    'evidence.view',
    'report.view',
  ],
  business_user: [
    'environment.pick',
    'workflow.view_published',
    'execution.start',
    'execution.control',
    'testcase.view',
    'evidence.view',
    'report.view',
  ],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const p of ROLE_PERMISSIONS[role]) out.add(p);
  return out;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}
