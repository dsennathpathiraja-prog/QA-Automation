import type {
  Actor,
  CapabilityDescriptor,
  ExecutionPolicy,
  InvokeRequest,
  ResolvedInstance,
} from './types';

export type Decision = { allow: true } | { allow: false; reason: string };
const allow: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

export function matchesPattern(pattern: string, capabilityId: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return capabilityId.startsWith(pattern.slice(0, -1));
  return pattern === capabilityId;
}

export interface PolicyInput {
  req: InvokeRequest;
  instance: ResolvedInstance;
  descriptor: CapabilityDescriptor;
  policy: ExecutionPolicy | undefined;
  actor: Actor;
}

/**
 * Machine policy: deny by default. Order matters only for the reported reason.
 */
export function evaluateMachinePolicy({ req, instance, descriptor, policy, actor }: PolicyInput): Decision {
  if (!instance.enabled) return deny('connector instance is disabled');
  if (instance.status === 'error' || instance.status === 'disconnected' || instance.status === 'draft') {
    if (!(actor.type === 'user' && req.capability === 'tm.capabilities.probe')) {
      return deny(`connector instance status is ${instance.status}`);
    }
  }
  if (instance.category !== descriptor.category) return deny('capability category does not match connector category');
  if (!instance.effectiveCapabilities.has(descriptor.id)) return deny('capability is not supported or not permitted for this connector instance');

  if (descriptor.access === 'write') {
    if (instance.accessMode === 'read_only') return deny('connector instance is read-only');
    if (descriptor.category === 'source-repo') return deny('source repositories are read-only');
  }
  if (descriptor.idempotent === 'key-required' && !req.idempotencyKey) {
    return deny('idempotency key is required for this capability');
  }

  if (actor.type === 'user') {
    // Interactive calls (wizard, test connection, lookups) need an explicit instance and the admin permission.
    if (!req.connectorInstanceId) return deny('interactive calls must name a connector instance');
    if (!actor.permissions?.includes('connector.manage') && !actor.permissions?.includes('connector.view_status')) {
      return deny('user lacks connector permission');
    }
    if (descriptor.access === 'write' && !actor.permissions.includes('connector.manage')) {
      return deny('user may not perform write capabilities interactively');
    }
    return allow;
  }

  if (!policy) return deny('no execution policy for this actor');
  if (!actor.executionId) return deny('execution id is required');

  for (const pattern of policy.capabilityDeny) {
    if (matchesPattern(pattern, descriptor.id)) return deny(`capability denied by execution policy (${pattern})`);
  }

  if (req.role) {
    const bound = policy.boundRoles[req.role];
    if (!bound) return deny(`role ${req.role} is not bound for this execution`);
    if (bound !== instance.id) return deny('connector instance does not match the execution role binding');
  } else if (req.connectorInstanceId && !Object.values(policy.boundRoles).includes(req.connectorInstanceId)) {
    return deny('connector instance is not bound to this execution');
  }

  if (actor.type === 'agent') {
    const grants = actor.agentKey ? policy.agentGrants[actor.agentKey] : undefined;
    if (!grants?.some((g) => g.capability === descriptor.id)) return deny('capability is not granted to this agent');
  }

  if (policy.environmentKind === 'production') {
    if (descriptor.category === 'browser-automation' && descriptor.access === 'write') {
      return deny('browser interaction is not allowed in production');
    }
  }
  if (descriptor.id === 'browser.interact' && policy.interactionPolicy === 'observe-only') {
    return deny('interaction policy is observe-only');
  }
  return allow;
}
