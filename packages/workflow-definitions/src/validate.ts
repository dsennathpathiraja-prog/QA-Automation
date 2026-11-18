import { createHash } from 'node:crypto';
import { TYPE_SPECS, stepType, stepsFor } from './catalog';
import { WORKFLOW_TYPES, type ValidateCtx, type ValidationIssue, type WfDef, type WfStep, type WorkflowKind } from './types';

const KINDS = ['development', 'qa', 'staging', 'uat', 'production'];
const PARAM_TYPES = ['string', 'integer', 'boolean', 'enum', 'work-item-ref', 'squash-scope', 'test-case-selection', 'environment-ref'];
const PAUSE = { safe: 0, boundary: 1, never: 2 } as const;
/** These are not available on the read-only connectors. A run previews them instead of blocking publish. */
const PREVIEW = new Set(['workitem.search', 'tm.suite.list', 'tm.tag.list', 'tm.testcase.upsert', 'tm.execution.upsert', 'tm.execution.status.update', 'tm.attachment.upload']);

const issue = (ruleId: string, severity: 'error' | 'warning', path: string, message: string, fixHint: string): ValidationIssue => ({ ruleId, severity, path, message, fixHint });
const err = (ruleId: string, path: string, message: string, fixHint: string) => issue(ruleId, 'error', path, message, fixHint);

const on = (s: WfStep) => s.enabled !== false;
const denied = (cap: string, patterns: readonly string[]) => patterns.some((p) => (p.endsWith('.*') ? cap.startsWith(p.slice(0, -1)) : cap === p));

export function contentHash(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canon((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

function pinnedOk(type: string, value: unknown): boolean {
  if (type === 'string' || type === 'enum') return typeof value === 'string';
  if (type === 'integer') return typeof value === 'number';
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' || (value !== null && typeof value === 'object');
}

function expressions(steps: WfStep[], parameters: { name: string }[], connectors: { role: string }[], issues: ValidationIssue[]) {
  const ids = new Map(steps.map((s) => [s.id, s]));
  const known = /\$\{(?:steps\.\*\.outputs|steps\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+|params\.[A-Za-z0-9_-]+|env\.[A-Za-z0-9_.-]+|connectors\.[A-Za-z0-9_-]+\.id)\}/g;
  for (const s of steps.filter(on)) {
    for (const [name, raw] of Object.entries(s.inputs ?? {})) {
      const path = `spec.steps.${s.id}.inputs.${name}`;
      const leftovers = raw.replace(known, '');
      if (leftovers.includes('${')) issues.push(err('V3', path, 'This input uses an expression the engine cannot read.', 'Use only ${steps.<id>.outputs.<name>}, ${params.<name>}, ${env.<field>}, or ${connectors.<role>.id}.'));
      for (const match of raw.matchAll(/\$\{steps\.([A-Za-z0-9_-]+)\.outputs\./g)) {
        const id = match[1] ?? '';
        const target = ids.get(id);
        if (!target) issues.push(err('V3', path, `Step "${id}" does not exist.`, 'Point the input at a step in this workflow.'));
        else if (!on(target)) issues.push(err('V3', path, `Step "${id}" is turned off.`, 'Turn that step on, or remove this input.'));
      }
      for (const match of raw.matchAll(/\$\{params\.([A-Za-z0-9_-]+)\}/g)) {
        const param = match[1] ?? '';
        if (!parameters.some((p) => p.name === param)) issues.push(err('V3', path, `Parameter "${param}" is not declared.`, 'Add the parameter or change the input.'));
      }
      for (const match of raw.matchAll(/\$\{connectors\.([A-Za-z0-9_-]+)\.id\}/g)) {
        const role = match[1] ?? '';
        if (!connectors.some((c) => c.role === role)) issues.push(err('V3', path, `Connector role "${role}" is not declared.`, 'Add that role under connectors.'));
      }
    }
  }
}

function graph(steps: WfStep[], issues: ValidationIssue[]) {
  const enabled = steps.filter(on);
  const ids = new Set(enabled.map((s) => s.id));
  const edges = new Map<string, string[]>();
  for (const s of enabled) {
    for (const dep of s.dependsOn ?? []) {
      const path = `spec.steps.${s.id}.dependsOn`;
      if (dep === s.id) issues.push(err('V3', path, `Step "${s.id}" depends on itself.`, 'Remove that dependency.'));
      else if (!steps.some((x) => x.id === dep)) issues.push(err('V3', path, `Step "${dep}" does not exist.`, 'Choose a step that is in this workflow.'));
      else if (!ids.has(dep)) issues.push(err('V3', path, `Step "${dep}" is turned off.`, 'Turn it on, or remove the dependency.'));
      else edges.set(s.id, [...(edges.get(s.id) ?? []), dep]);
    }
  }
  const color = new Map<string, number>();
  const visit = (id: string): boolean => {
    const c = color.get(id) ?? 0;
    if (c === 1) return true;
    if (c === 2) return false;
    color.set(id, 1);
    for (const next of edges.get(id) ?? []) if (visit(next)) return true;
    color.set(id, 2);
    return false;
  };
  if (enabled.some((s) => visit(s.id))) issues.push(err('V3', 'spec.steps', 'The step dependencies loop.', 'Remove a dependency so each step is reached once.'));
  const index = new Map<string, number>();
  steps.forEach((s, i) => { if (on(s)) index.set(s.type, i); });
  for (const s of enabled) {
    const desc = stepType(s.type);
    const here = index.get(s.type);
    if (!desc || here === undefined) continue;
    for (const prev of desc.after) {
      const at = index.get(prev);
      if (at !== undefined && at > here) issues.push(err('V3', `spec.steps.${s.id}`, `${s.type} must run after ${prev}.`, 'Move that step below the one it follows.'));
    }
  }
}

export function validateWorkflow(input: unknown, ctx: ValidateCtx = { instances: [] }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [err('V1', '', 'The definition must be an object.', 'Start again from a template.')];
  const def = input as Partial<WfDef>;
  if (def.schemaVersion !== '1.0' || def.kind !== 'WorkflowDefinition') issues.push(err('V1', 'schemaVersion', 'This definition is not schema 1.0.', 'Use a current template.'));
  const spec = def.spec;
  if (!spec || !Array.isArray(spec.steps) || !Array.isArray(spec.connectors) || !Array.isArray(spec.parameters) || !spec.environment || !spec.execution || !spec.policy || !Array.isArray(spec.approvals)) {
    return [...issues, err('V1', 'spec', 'The definition is missing steps, connectors, parameters, or settings.', 'Start again from a template.')];
  }
  const kind = def.metadata?.type;
  if (!kind || !(WORKFLOW_TYPES as readonly string[]).includes(kind)) {
    return [...issues, err('V1', 'metadata.type', 'The workflow type must be requirement validation or regression testing.', 'Pick one of those types.')];
  }
  const type = kind as WorkflowKind;
  const steps = spec.steps;
  const ids = new Set<string>();
  for (const s of steps) {
    const path = `spec.steps.${s.id || '?'}`;
    if (!s.id || ids.has(s.id)) issues.push(err('V1', path, 'Each step needs its own id.', 'Give the step a unique id.'));
    ids.add(s.id);
    const desc = stepType(s.type);
    if (!desc || desc.workflow !== type) issues.push(err('V2', path, `Step type "${s.type}" is not part of this workflow.`, 'Remove the step or change the workflow type.'));
    else if (s.typeVersion !== 1) issues.push(err('V1', path, 'This step version is not supported.', 'Use type version 1.'));
    if (s.config !== undefined && (s.config === null || typeof s.config !== 'object' || Array.isArray(s.config))) issues.push(err('V1', `${path}.config`, 'Step options must be an object.', 'Replace the options with fields from the step type.'));
    if (desc && s.pause && PAUSE[s.pause] < PAUSE[desc.pause]) issues.push(err('V1', `${path}.pause`, 'Pause cannot be made looser than the step type allows.', `Leave pause as ${desc.pause}.`));
  }

  const allowed = stepsFor(type);
  for (const desc of allowed) {
    const found = steps.find((s) => s.type === desc.type);
    const enabled = found ? on(found) : false;
    if (desc.mandatory && !enabled) issues.push(err('V2', `spec.steps.${desc.type}`, `${desc.type} is required and must stay on.`, 'Turn the step back on. A required step cannot be skipped.'));
    if (desc.mandatoryIfAnyEnabled?.some((t) => steps.some((s) => s.type === t && on(s))) && !enabled) issues.push(err('V2', `spec.steps.${desc.type}`, `${desc.type} is required because an earlier step is on.`, 'Turn this step on.'));
  }
  const specRule = TYPE_SPECS[type];
  if (specRule.atLeastOneOf.length > 0 && !specRule.atLeastOneOf.some((t) => steps.some((s) => s.type === t && on(s)))) {
    issues.push(err('V2', 'spec.steps', 'Turn on UI exploration, code exploration, or both.', 'A requirement validation workflow needs at least one exploration step.'));
  }

  graph(steps, issues);
  expressions(steps, spec.parameters, spec.connectors, issues);

  const enabled = steps.filter(on);
  for (const s of enabled) {
    const desc = stepType(s.type);
    if (!desc) continue;
    for (const role of desc.roles) {
      const declared = spec.connectors.find((c) => c.role === role.role);
      const path = `spec.connectors.${role.role}`;
      if (!declared) {
        issues.push(err('V5', path, `Role ${role.role} is missing.`, 'Add that connector role.'));
        continue;
      }
      const inst = ctx.instances.find((i) => i.role === role.role);
      if (!inst) {
        issues.push(err('V5', path, `Bind a connector for ${role.role}.`, 'Choose a connector on the Connectors tab.'));
        continue;
      }
      if (inst.category !== declared.category) issues.push(err('V5', path, `${role.role} is bound to the wrong kind of connector.`, `Choose a ${declared.category} connector.`));
      if (!inst.enabled || (inst.health !== 'healthy' && inst.health !== 'degraded')) issues.push(err('V4', path, `The connector for ${role.role} is not usable.`, 'Enable it and wait until its last check is healthy or degraded.'));
      for (const cap of new Set([...role.required, ...declared.requiredCapabilities])) {
        if (inst.capabilities.includes(cap)) continue;
        if (PREVIEW.has(cap)) issues.push(issue('V4b', 'warning', path, `${role.role} does not offer ${cap}. That part of the run stays a preview and is not written back.`, 'Use a connector that offers it, or accept the preview.'));
        else issues.push(err('V4', path, `The connector for ${role.role} cannot ${cap}.`, 'Pick a connector whose last check includes that capability, or turn the step off if it is optional.'));
      }
      for (const cap of declared.optionalCapabilities ?? []) {
        if (!inst.capabilities.includes(cap)) issues.push(issue('V4b', 'warning', path, `${role.role} does not offer ${cap}. That part of the run will be skipped.`, 'Use a connector that offers it, or accept the gap.'));
      }
      if (declared.category === 'source-repo' && inst.accessMode !== 'read_only') issues.push(err('V6', path, 'A source repository connector must be read-only.', 'Use a read-only token. The platform does not write to source repositories.'));
    }
  }

  for (const pattern of specRule.deny) {
    if (!spec.policy.capabilityDeny.includes(pattern)) issues.push(err('V7', 'spec.policy.capabilityDeny', `The deny list must include ${pattern}.`, 'Add it back. A workflow can deny more, not less.'));
  }
  for (const s of enabled) {
    const desc = stepType(s.type);
    for (const role of desc?.roles ?? []) {
      for (const cap of role.required) {
        if (denied(cap, spec.policy.capabilityDeny)) issues.push(err('V7', `spec.steps.${s.id}`, `${s.type} needs ${cap}, which this workflow denies.`, 'Remove the step or narrow the deny list without dropping the type rules.'));
      }
    }
  }

  const env = spec.environment;
  if (!Array.isArray(env.allowedKinds) || env.allowedKinds.some((k) => !KINDS.includes(k))) issues.push(err('V8', 'spec.environment.allowedKinds', 'An environment kind is not recognised.', 'Use development, qa, staging, uat, or production.'));
  if (env.pinnedEnvironmentId) {
    const found = ctx.environment;
    if (!found) issues.push(err('V8', 'spec.environment.pinnedEnvironmentId', 'The pinned environment does not exist.', 'Pick another environment or unpin it.'));
    else if (!found.enabled) issues.push(err('V8', 'spec.environment.pinnedEnvironmentId', 'The pinned environment is disabled.', 'Enable it or unpin it.'));
    else if (!env.allowedKinds.includes(found.kind)) issues.push(err('V8', 'spec.environment.pinnedEnvironmentId', `A ${found.kind} environment is not allowed here.`, 'Change the allowed kinds or pick another environment.'));
    else if (found.kind === 'production' && !env.production.allowed) issues.push(err('V8', 'spec.environment.production', 'This workflow does not allow production.', 'Turn production on only when a production gate is in place.'));
    else if (found.kind === 'production' && !found.productionAuthorized) issues.push(err('V8', 'spec.environment.pinnedEnvironmentId', 'Production is not authorized for that environment.', 'Ask an administrator for an active production authorization.'));
  }

  const seen = new Set<string>();
  for (const p of spec.parameters) {
    if (seen.has(p.name)) issues.push(err('V9', `spec.parameters.${p.name}`, 'Parameter names must be unique.', 'Rename one of them.'));
    seen.add(p.name);
    if (!PARAM_TYPES.includes(p.type)) issues.push(err('V9', `spec.parameters.${p.name}`, `Parameter type "${p.type}" is not supported.`, 'Use one of the run-wizard types.'));
    if (p.pinned !== undefined && p.pinned !== null && !pinnedOk(p.type, p.pinned)) issues.push(err('V9', `spec.parameters.${p.name}`, 'The pinned value does not match the parameter type.', 'Clear it or enter a value of the right type.'));
  }

  if (env.production?.requiresApproval !== true) issues.push(err('V10', 'spec.environment.production.requiresApproval', 'Production approval cannot be turned off.', 'Set requiresApproval back to true.'));
  if (env.production?.allowed && !spec.approvals.some((a) => a.when === 'environment-kind:production')) issues.push(err('V10', 'spec.approvals', 'Production needs an approval gate.', 'Add a gate whose when is environment-kind:production.'));
  for (const a of spec.approvals) {
    if (!['before-start', 'before-step', 'after-step'].includes(a.gate)) issues.push(err('V10', `spec.approvals.${a.id}`, 'The approval gate is not recognised.', 'Use before-start, before-step, or after-step.'));
    if ((a.gate === 'before-step' || a.gate === 'after-step') && !steps.some((s) => s.id === a.stepId)) issues.push(err('V10', `spec.approvals.${a.id}`, 'The approval points at a missing step.', 'Choose a step that exists.'));
  }

  const ex = spec.execution;
  if (ex.maxParallelism < 1 || ex.maxParallelism > 32) issues.push(err('V11', 'spec.execution.maxParallelism', 'Parallelism must be from 1 to 32.', 'Lower or raise it into that range.'));
  if (ex.timeoutMinutes < 1 || ex.timeoutMinutes > 1440) issues.push(err('V11', 'spec.execution.timeoutMinutes', 'The workflow timeout must be from 1 to 1440 minutes.', 'Choose a timeout in that range.'));
  if (ex.retention?.artifactDays < 1 || ex.retention?.artifactDays > 3650) issues.push(err('V11', 'spec.execution.retention.artifactDays', 'Artifact retention must be from 1 to 3650 days.', 'Choose a retention in that range.'));
  for (const s of steps) {
    if (s.timeoutMinutes !== undefined && (s.timeoutMinutes < 1 || s.timeoutMinutes > 240)) issues.push(err('V11', `spec.steps.${s.id}.timeoutMinutes`, 'A step timeout must be from 1 to 240 minutes.', 'Choose a timeout in that range.'));
    if (s.retry) {
      if (s.retry.maxAttempts < 1 || s.retry.maxAttempts > 5) issues.push(err('V11', `spec.steps.${s.id}.retry.maxAttempts`, 'A step can retry from 1 to 5 times.', 'Lower the attempt count.'));
      if (s.retry.initialDelaySec !== undefined && (s.retry.initialDelaySec < 0 || s.retry.initialDelaySec > 300)) issues.push(err('V11', `spec.steps.${s.id}.retry.initialDelaySec`, 'Retry delay must be from 0 to 300 seconds.', 'Shorten the delay.'));
      if (s.retry.backoff !== undefined && s.retry.backoff !== 'fixed' && s.retry.backoff !== 'exponential') issues.push(err('V11', `spec.steps.${s.id}.retry.backoff`, 'Backoff must be fixed or exponential.', 'Pick one of those.'));
    }
  }
  return issues;
}

export const errorsOf = (issues: readonly ValidationIssue[]) => issues.filter((i) => i.severity === 'error');
