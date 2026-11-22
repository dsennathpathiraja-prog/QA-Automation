import { randomUUID } from 'node:crypto';
import type {
  CaseRunStatus,
  NotAutomatedCase,
  ResolvedAutomation,
  TestCaseService,
  WorkItemRunRecord,
} from '@qa/application';
import { isPlaceholderScreenshot } from '@qa/application';
import { PlatformError } from '@qa/domain';
import { runWorkItemCases, type CaseOutcome, type WorkItemCaseInput } from './run-work-item';

export type FlowResult = { summary: string; outputs: Record<string, unknown> };

export type { EnvironmentTarget } from './select-environment';
import type { EnvironmentTarget } from './select-environment';

export type ExecuteTestsDeps = {
  /** Look up a platform environment by id (from run params / select_env). */
  resolveEnvironment?: (id: string) => Promise<EnvironmentTarget | undefined>;
  /** Persist live progress + screenshots on Executions (Phase 7/8 path). */
  testCases?: TestCaseService;
  /**
   * Run approved cases through the Playwright runner (same as work-item Executions).
   * Omit to force Blocked (runner required) without launching.
   */
  runCases?: (input: {
    run: WorkItemRunRecord;
    cases: WorkItemCaseInput[];
    url: string;
    onProgress?: (results: CaseOutcome[]) => Promise<void> | void;
  }) => Promise<{ viaRunner: boolean; results: CaseOutcome[] }>;
};

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '');

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined);

const NOT_AUTOMATED_REASON: Record<string, string> = {
  'mapping-unapproved': 'Not Automated: mapping is draft (not approved).',
  'no-mapping': 'Not Automated: no Squash↔script mapping.',
  'asset-missing': 'Not Automated: mapped automation asset is missing.',
};

function isApprovedResolved(row: unknown): row is ResolvedAutomation {
  const r = asRecord(row);
  if (!r) return false;
  return text(r.status) === 'approved'
    && !!text(r.squashCaseId)
    && !!text(r.assetId)
    && !!text(r.assetName);
}

function asNotAutomated(row: unknown): NotAutomatedCase | undefined {
  const r = asRecord(row);
  if (!r) return undefined;
  const squashCaseId = text(r.squashCaseId);
  const reason = text(r.reason);
  if (!squashCaseId) return undefined;
  if (reason !== 'mapping-unapproved' && reason !== 'no-mapping' && reason !== 'asset-missing') return undefined;
  return {
    squashCaseId,
    reason,
    ...(text(r.squashReference) ? { squashReference: text(r.squashReference) } : {}),
    ...(text(r.assetId) ? { assetId: text(r.assetId) } : {}),
    ...(text(r.status) === 'draft' || text(r.status) === 'approved' ? { status: text(r.status) as 'draft' | 'approved' } : {}),
  };
}

/** Read resolve outputs from prior `resolve_automation` step (or params.automation / params.resolved). */
export function regressionAutomationFromStep(step: {
  params: Record<string, unknown>;
  prior: Record<string, Record<string, unknown>>;
}): { resolved: ResolvedAutomation[]; notAutomated: NotAutomatedCase[] } {
  const prior = step.prior.resolve_automation ?? {};
  const fromPriorResolved = Array.isArray(prior.resolved) ? prior.resolved : [];
  const fromPriorSkipped = Array.isArray(prior.notAutomated) ? prior.notAutomated : [];

  const paramAutomation = step.params.automation;
  const paramResolved = Array.isArray(paramAutomation)
    ? paramAutomation
    : Array.isArray(asRecord(paramAutomation)?.resolved)
      ? (asRecord(paramAutomation)!.resolved as unknown[])
      : Array.isArray(step.params.resolved)
        ? step.params.resolved as unknown[]
        : [];
  const paramSkipped = Array.isArray(asRecord(paramAutomation)?.notAutomated)
    ? (asRecord(paramAutomation)!.notAutomated as unknown[])
    : Array.isArray(step.params.notAutomated)
      ? step.params.notAutomated as unknown[]
      : [];

  const resolvedSource = fromPriorResolved.length > 0 ? fromPriorResolved : paramResolved;
  const skippedSource = fromPriorSkipped.length > 0 ? fromPriorSkipped : paramSkipped;

  const resolved = resolvedSource.filter(isApprovedResolved);
  const notAutomated = skippedSource.map(asNotAutomated).filter((row): row is NotAutomatedCase => !!row);

  // Anything that claimed to be resolved but is not approved must never execute.
  for (const row of resolvedSource) {
    if (isApprovedResolved(row)) continue;
    const r = asRecord(row);
    const squashCaseId = text(r?.squashCaseId);
    if (!squashCaseId) continue;
    if (notAutomated.some((n) => n.squashCaseId === squashCaseId)) continue;
    notAutomated.push({
      squashCaseId,
      reason: 'mapping-unapproved',
      ...(text(r?.assetId) ? { assetId: text(r?.assetId) } : {}),
      ...(text(r?.status) === 'draft' ? { status: 'draft' } : {}),
    });
  }

  return { resolved, notAutomated };
}

/** Environment URL for Playwright open+capture — prefer select_env outputs, then run params. */
export async function regressionEnvironmentTarget(
  step: { params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  resolveEnvironment?: (id: string) => Promise<EnvironmentTarget | undefined>,
): Promise<EnvironmentTarget | undefined> {
  const asEnvId = (...candidates: string[]) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const c of candidates) {
      if (uuid.test(c)) return c;
    }
    return randomUUID();
  };

  const priorResolved = asRecord(step.prior.select_env?.resolved);
  if (priorResolved) {
    const applicationUrl = text(priorResolved.applicationUrl);
    if (applicationUrl) {
      return {
        id: asEnvId(text(priorResolved.id)),
        name: text(priorResolved.name) || 'Environment',
        applicationUrl,
      };
    }
  }

  const directUrl = text(step.params.applicationUrl);
  if (directUrl) {
    return {
      id: asEnvId(text(step.params.environmentId), text(step.params.environment)),
      name: text(step.params.environmentName) || 'Environment',
      applicationUrl: directUrl,
    };
  }

  const envParam = step.params.environment;
  const envId = text(asRecord(envParam)?.id) || text(envParam) || text(step.params.environmentId);
  if (envId && resolveEnvironment) {
    const row = await resolveEnvironment(envId);
    if (row?.applicationUrl) return row;
  }

  const nested = asRecord(envParam);
  const nestedUrl = text(nested?.applicationUrl);
  if (nestedUrl) {
    return {
      id: asEnvId(text(nested?.id)),
      name: text(nested?.name) || 'Environment',
      applicationUrl: nestedUrl,
    };
  }

  return undefined;
}

export function notAutomatedOutcome(row: NotAutomatedCase): CaseOutcome {
  const reason = NOT_AUTOMATED_REASON[row.reason] ?? `Not Automated: ${row.reason}`;
  const testCaseId = row.assetId && /^[0-9a-f-]{36}$/i.test(row.assetId) ? row.assetId : randomUUID();
  return {
    testCaseId,
    name: `Squash ${row.squashCaseId}`,
    status: 'Skipped',
    message: reason,
    steps: [
      { name: 'Open page', status: 'Skipped' },
      { name: 'Capture evidence', status: 'Skipped' },
    ],
  };
}

export function approvedCaseInput(row: ResolvedAutomation): WorkItemCaseInput {
  return {
    id: row.assetId,
    name: row.assetName,
    steps: `Open page\nCapture evidence\n# ${row.scriptPath}`,
    summary: `Squash ${row.squashCaseId} → ${row.assetKey} (${row.scriptPath})`,
    expected: 'Passed with screenshot evidence',
  };
}

export function summarizeExecuteResults(o: {
  executed: number;
  notAutomated: number;
  viaRunner: boolean;
  results: Array<{ status: CaseRunStatus }>;
}): string {
  if (o.executed === 0 && o.notAutomated === 0) {
    return 'No approved automation to execute for Regression.';
  }
  const tally = { Passed: 0, Failed: 0, Blocked: 0, Skipped: 0, Queued: 0, Running: 0 };
  for (const r of o.results) {
    if (r.status in tally) tally[r.status as keyof typeof tally] += 1;
  }
  const parts = (['Passed', 'Failed', 'Blocked', 'Skipped'] as const)
    .filter((k) => tally[k] > 0)
    .map((k) => `${tally[k]} ${k}`);
  const runner = o.viaRunner ? 'via Playwright runner' : 'without runner';
  const skippedNote = o.notAutomated > 0 ? ` ${o.notAutomated} Not Automated skipped (never generated).` : '';
  return `Regression execute ${runner}: ${parts.join(', ') || 'no results'}.${skippedNote}`;
}

function compactResult(row: CaseOutcome & { squashCaseId?: string }): Record<string, unknown> {
  return {
    testCaseId: row.testCaseId,
    name: row.name,
    status: row.status,
    message: row.message,
    hasScreenshot: Boolean(row.screenshotPng) && !isPlaceholderScreenshot(row.screenshotPng),
    ...(row.squashCaseId ? { squashCaseId: row.squashCaseId } : {}),
    ...(row.squashExecutionId ? { squashExecutionId: row.squashExecutionId } : {}),
    ...(row.steps ? { steps: row.steps } : {}),
  };
}

/**
 * Phase 9 E2 — `rg.execute-tests`: run resolved **approved** assets via Playwright runner.
 * Not Automated / draft are Skipped — never executed, never explore/generate.
 */
export async function performExecuteTests(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  deps: ExecuteTestsDeps = {},
): Promise<FlowResult> {
  if (step.type !== 'rg.execute-tests') {
    throw new PlatformError('internal', `performExecuteTests does not handle ${step.type}`);
  }

  const { resolved, notAutomated } = regressionAutomationFromStep(step);
  const skipped = notAutomated.map(notAutomatedOutcome);
  const cases = resolved.map(approvedCaseInput);

  if (cases.length === 0) {
    const results = skipped;
    return {
      summary: summarizeExecuteResults({ executed: 0, notAutomated: notAutomated.length, viaRunner: false, results }),
      outputs: {
        results: results.map((r, i) => compactResult({ ...r, squashCaseId: notAutomated[i]?.squashCaseId })),
        notAutomated,
        viaRunner: false,
        executed: 0,
      },
    };
  }

  const env = await regressionEnvironmentTarget(step, deps.resolveEnvironment);
  if (!env?.applicationUrl) {
    throw new PlatformError(
      'validation',
      'Regression execute needs an environment application URL (run param environment / applicationUrl, or select_env outputs).',
    );
  }

  const evidenceLabel = `rg:${step.runId}`.slice(0, 120);
  let evidenceId: string | undefined;
  let run: WorkItemRunRecord = {
    id: randomUUID(),
    workItem: evidenceLabel,
    environmentId: env.id,
    environmentName: env.name,
    caseCount: cases.length + skipped.length,
    status: 'running',
    createdAt: new Date(),
  };

  if (deps.testCases) {
    const opened = await deps.testCases.beginRegressionEvidenceRun({
      label: evidenceLabel,
      environmentId: env.id,
      environmentName: env.name,
      cases: [
        ...cases.map((c) => ({ testCaseId: c.id, name: c.name, steps: c.steps })),
        ...skipped.map((s) => ({
          testCaseId: s.testCaseId,
          name: s.name,
          steps: 'Open page\nCapture evidence',
          status: 'Skipped' as const,
          message: s.message,
        })),
      ],
    });
    evidenceId = opened.id;
    run = {
      id: opened.id,
      workItem: opened.workItem,
      environmentId: opened.environmentId,
      environmentName: opened.environmentName,
      caseCount: opened.caseCount,
      status: 'running',
      createdAt: new Date(opened.createdAt),
    };
  }

  const onProgress = deps.testCases && evidenceId
    ? async (partial: CaseOutcome[]) => {
        const merged = mergeById([...skipped, ...partial]);
        await deps.testCases!.reportWorkItemProgress(evidenceId!, merged);
      }
    : undefined;

  let viaRunner = false;
  let executed: CaseOutcome[];
  if (deps.runCases) {
    const ran = await deps.runCases({ run, cases, url: env.applicationUrl, onProgress });
    viaRunner = ran.viaRunner;
    executed = ran.results;
  } else {
    // Same fail-closed behaviour as Executions without a launcher (QA-54).
    const ran = await runWorkItemCases({ run, cases, url: env.applicationUrl, onProgress });
    viaRunner = ran.viaRunner;
    executed = ran.results;
  }

  const results = mergeById([...skipped, ...executed]);
  if (deps.testCases && evidenceId) {
    const runnable = results.filter((r) => r.status !== 'Skipped');
    const allBlocked = runnable.length > 0 && runnable.every((r) => r.status === 'Blocked');
    await deps.testCases.completeWorkItemExecution(evidenceId, {
      status: allBlocked ? 'failed' : 'completed',
      squashSync: 'Regression evidence stored on the platform. Squash status sync runs in rg.update-squash.',
      results,
    });
  }

  const squashByAsset = new Map(resolved.map((r) => [r.assetId, r.squashCaseId]));
  const squashBySkipped = new Map(skipped.map((s, i) => [s.testCaseId, notAutomated[i]?.squashCaseId]));

  return {
    summary: summarizeExecuteResults({
      executed: cases.length,
      notAutomated: notAutomated.length,
      viaRunner,
      results,
    }),
    outputs: {
      results: results.map((r) => compactResult({
        ...r,
        squashCaseId: squashByAsset.get(r.testCaseId) ?? squashBySkipped.get(r.testCaseId),
      })),
      notAutomated,
      viaRunner,
      executed: cases.length,
      evidenceExecutionId: evidenceId,
      environment: { id: env.id, name: env.name, applicationUrl: env.applicationUrl },
    },
  };
}

function mergeById(rows: CaseOutcome[]): CaseOutcome[] {
  const byId = new Map<string, CaseOutcome>();
  for (const row of rows) byId.set(row.testCaseId, row);
  return [...byId.values()];
}
