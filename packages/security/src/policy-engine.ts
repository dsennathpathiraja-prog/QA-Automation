import { permissionsForRoles, type Permission, type Role } from '@qa/domain';

export interface Principal {
  id: string;
  displayName: string;
  roles: readonly Role[];
}

export interface AuthorizationContext {
  /** Resource attributes used by attribute rules (ABAC on top of RBAC). */
  resource?: {
    ownerId?: string;
    authorId?: string;
    requesterId?: string;
    businessRunnable?: boolean;
    environmentKind?: 'development' | 'qa' | 'staging' | 'uat' | 'production';
    productionAuthorized?: boolean;
    productionAllowedByWorkflow?: boolean;
  };
}

export type AuthDecision = { allow: true } | { allow: false; reason: string; code: 'forbidden' | 'rule' };

type Rule = (p: Principal, action: Permission, ctx: AuthorizationContext) => AuthDecision | undefined;

const rules: Rule[] = [
  // Maker-checker: a publisher cannot approve their own publication.
  (p, action, ctx) =>
    action === 'workflow.publish.approve' && ctx.resource?.authorId === p.id
      ? { allow: false, code: 'rule', reason: 'maker-checker: authors cannot approve their own publication' }
      : undefined,
  // Two-person rule for production runs.
  (p, action, ctx) =>
    action === 'execution.approve.production' && ctx.resource?.requesterId === p.id
      ? { allow: false, code: 'rule', reason: 'two-person rule: requester cannot approve their own production run' }
      : undefined,
  // Production runs need an active environment authorization and workflow-level allowance.
  (_p, action, ctx) => {
    if (action !== 'execution.start.production') return undefined;
    if (!ctx.resource?.productionAuthorized) return { allow: false, code: 'rule', reason: 'environment has no active production authorization' };
    if (!ctx.resource?.productionAllowedByWorkflow) return { allow: false, code: 'rule', reason: 'workflow version is not approved for production' };
    return undefined;
  },
  // Business users may only start workflows a QA Lead flagged as business-runnable.
  (p, action, ctx) =>
    action === 'execution.start' && p.roles.length > 0 && p.roles.every((r) => r === 'business_user') && ctx.resource?.businessRunnable !== true
      ? { allow: false, code: 'rule', reason: 'workflow is not approved for business users' }
      : undefined,
  // Own-execution control unless the broader permission is held (checked by caller via both actions).
  (p, action, ctx) =>
    action === 'execution.control' && ctx.resource?.ownerId !== undefined && ctx.resource.ownerId !== p.id
      ? { allow: false, code: 'rule', reason: 'only the owner may control this execution' }
      : undefined,
];

export class PolicyEngine {
  permissionsOf(p: Principal): Set<Permission> {
    return permissionsForRoles(p.roles);
  }

  can(p: Principal, action: Permission, ctx: AuthorizationContext = {}): AuthDecision {
    if (!this.permissionsOf(p).has(action)) return { allow: false, code: 'forbidden', reason: `missing permission ${action}` };
    for (const rule of rules) {
      const r = rule(p, action, ctx);
      if (r) return r;
    }
    return { allow: true };
  }

  /** Control: owner with execution.control, or anyone holding execution.control.any. */
  canControlExecution(p: Principal, ownerId: string): AuthDecision {
    if (this.permissionsOf(p).has('execution.control.any')) return { allow: true };
    return this.can(p, 'execution.control', { resource: { ownerId } });
  }
}
