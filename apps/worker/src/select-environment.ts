import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';

export type FlowResult = { summary: string; outputs: Record<string, unknown> };

export type EnvironmentTarget = {
  id: string;
  name: string;
  applicationUrl: string;
};

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '');

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asEnvId(...candidates: string[]): string {
  for (const c of candidates) {
    if (UUID_RE.test(c)) return c;
  }
  return randomUUID();
}

/**
 * Phase 9 E2 helper — thin `rg.select-environment` so execute can read prior.select_env.resolved.
 * Full suite/campaign scope stays E3; this only resolves the run's environment-ref.
 */
export async function performSelectEnvironment(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  resolveEnvironment: ((id: string) => Promise<EnvironmentTarget | undefined>) | undefined,
): Promise<FlowResult> {
  if (step.type !== 'rg.select-environment') {
    throw new PlatformError('internal', `performSelectEnvironment does not handle ${step.type}`);
  }

  const envParam = step.params.environment;
  const nested = asRecord(envParam);
  const directUrl = text(step.params.applicationUrl) || text(nested?.applicationUrl);
  if (directUrl) {
    const resolved = {
      id: asEnvId(text(nested?.id), text(step.params.environmentId), text(envParam)),
      name: text(nested?.name) || text(step.params.environmentName) || 'Environment',
      applicationUrl: directUrl,
      ...(text(nested?.kind) ? { kind: text(nested?.kind) } : {}),
    };
    return {
      summary: `Selected environment ${resolved.name} (${resolved.applicationUrl}).`,
      outputs: { resolved },
    };
  }

  const envId = text(nested?.id) || text(envParam) || text(step.params.environmentId);
  if (!envId) {
    return {
      summary: 'No environment selected for Regression.',
      outputs: { resolved: null },
    };
  }
  if (!resolveEnvironment) {
    throw new PlatformError('denied', 'Regression environment select requires the environment repository on the worker.');
  }
  const row = await resolveEnvironment(envId);
  if (!row?.applicationUrl) {
    throw new PlatformError('not-found', 'That environment was not found or has no application URL.');
  }
  const resolved = {
    id: row.id,
    name: row.name,
    applicationUrl: row.applicationUrl,
  };
  return {
    summary: `Selected environment ${resolved.name} (${resolved.applicationUrl}).`,
    outputs: { resolved },
  };
}
