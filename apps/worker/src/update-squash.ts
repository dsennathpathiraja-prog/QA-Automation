import type { TestCaseService } from '@qa/application';
import { PlatformError } from '@qa/domain';
import type { CaseOutcome } from './run-work-item';
import { syncCaseResultsToSquash } from './sync-execution';

export type FlowResult = { summary: string; outputs: Record<string, unknown> };

export type WritableSquashSync = {
  upsert: (testCaseId: string) => Promise<{ id: string; created: boolean }>;
  updateStatus: (executionId: string, status: string, actualResult?: string) => Promise<void>;
  uploadAttachment?: (input: {
    executionId: string;
    testCaseId: string;
    name: string;
    contentBase64: string;
    sha256: string;
  }) => Promise<{ id: string }>;
};

export type UpdateSquashDeps = {
  /**
   * Resolve a write-capable Squash sync surface (`tm.execution.upsert` on a read_write connector).
   * Return undefined to degrade clearly — never silent fail.
   */
  resolveWritable?: () => Promise<WritableSquashSync | undefined>;
  /** Refresh Executions evidence row `squashSync` after status sync. */
  testCases?: TestCaseService;
};

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '');

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined);

const STATUS = new Set(['Queued', 'Running', 'Passed', 'Failed', 'Blocked', 'Skipped']);

/** Compact execute outputs (or params.results) → CaseOutcome rows for sync. */
export function caseOutcomesFromRegressionResults(raw: unknown): CaseOutcome[] {
  if (!Array.isArray(raw)) return [];
  const out: CaseOutcome[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const testCaseId = text(row.testCaseId);
    const name = text(row.name) || testCaseId;
    const status = text(row.status);
    if (!testCaseId || !STATUS.has(status)) continue;
    out.push({
      testCaseId,
      name,
      status: status as CaseOutcome['status'],
      message: text(row.message) || status,
      ...(text(row.screenshotPng) ? { screenshotPng: text(row.screenshotPng) } : {}),
      ...(text(row.squashExecutionId) ? { squashExecutionId: text(row.squashExecutionId) } : {}),
      ...(Array.isArray(row.steps)
        ? {
          steps: row.steps
            .map((s) => asRecord(s))
            .filter((s): s is Record<string, unknown> => !!s)
            .map((s) => ({
              name: text(s.name) || 'step',
              status: (STATUS.has(text(s.status)) ? text(s.status) : 'Skipped') as CaseOutcome['status'],
            })),
        }
        : {}),
    });
  }
  return out;
}

export function squashCaseIdByTestCase(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(raw)) return map;
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const testCaseId = text(row.testCaseId);
    const squashCaseId = text(row.squashCaseId);
    if (testCaseId && squashCaseId) map.set(testCaseId, squashCaseId);
  }
  return map;
}

export function regressionResultsFromStep(step: {
  runId?: string;
  params: Record<string, unknown>;
  prior: Record<string, Record<string, unknown>>;
}): { results: unknown[]; evidenceExecutionId?: string; workItem: string } {
  const priorExecute = step.prior.execute ?? {};
  const fromPrior = Array.isArray(priorExecute.results) ? priorExecute.results : [];
  const fromParams = Array.isArray(step.params.results) ? step.params.results : [];
  const results = fromPrior.length > 0 ? fromPrior : fromParams;
  const evidenceExecutionId = text(priorExecute.evidenceExecutionId) || text(step.params.evidenceExecutionId) || undefined;
  const runId = text(step.runId) || 'run';
  const workItem = text(step.params.workItem) || `rg:${runId}`.slice(0, 120);
  return { results, evidenceExecutionId, workItem };
}

export function summarizeUpdateSquash(o: { writable: boolean; synced: number; summary: string; total: number }): string {
  if (o.total === 0) return 'No Regression results to sync to Squash.';
  if (!o.writable) return o.summary;
  return o.summary;
}

function countSynced(results: CaseOutcome[]): number {
  return results.filter((r) => !!r.squashExecutionId).length;
}

function countAttached(summary: string): number {
  const m = /uploaded (\d+) screenshot attachment/i.exec(summary);
  return m ? Number(m[1]) : 0;
}

function isDegradedSummary(summary: string, writable: boolean): boolean {
  if (!writable) return true;
  return /Squash was not updated|No writable Squash|was not available|Screenshot attachments were not uploaded|then stopped:/i.test(summary);
}

async function hydrateScreenshots(
  results: CaseOutcome[],
  evidenceExecutionId: string | undefined,
  testCases: TestCaseService | undefined,
): Promise<CaseOutcome[]> {
  if (!evidenceExecutionId || !testCases) return results;
  const out: CaseOutcome[] = [];
  for (const row of results) {
    if (row.screenshotPng) {
      out.push(row);
      continue;
    }
    try {
      const shot = await testCases.caseScreenshot(evidenceExecutionId, row.testCaseId);
      out.push({ ...row, screenshotPng: shot.pngBase64 });
    } catch {
      out.push(row);
    }
  }
  return out;
}

/**
 * Phase 9 E5 — `rg.update-squash`: push execution status (and screenshots when WRITE allows).
 * When no writable Squash connector is available, degrade with an explicit summary — never silent.
 */
export async function performUpdateSquash(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  deps: UpdateSquashDeps = {},
): Promise<FlowResult> {
  if (step.type !== 'rg.update-squash') {
    throw new PlatformError('internal', `performUpdateSquash does not handle ${step.type}`);
  }

  const { results: rawResults, evidenceExecutionId, workItem } = regressionResultsFromStep(step);
  const squashIds = squashCaseIdByTestCase(rawResults);
  let outcomes = caseOutcomesFromRegressionResults(rawResults);
  outcomes = await hydrateScreenshots(outcomes, evidenceExecutionId, deps.testCases);

  if (outcomes.length === 0) {
    const sync = {
      summary: 'No Regression results to sync to Squash.',
      writable: false,
      synced: 0,
      attached: 0,
      degraded: true,
      results: [],
    };
    return { summary: sync.summary, outputs: { sync } };
  }

  const writable = deps.resolveWritable ? await deps.resolveWritable() : undefined;
  if (!writable) {
    const summary = `Cases ran for ${workItem}. No writable Squash connector is switched on.`;
    if (deps.testCases && evidenceExecutionId) {
      await deps.testCases.completeWorkItemExecution(evidenceExecutionId, {
        status: 'completed',
        squashSync: summary,
        results: outcomes,
      }).catch(() => undefined);
    }
    const sync = {
      summary,
      writable: false,
      synced: 0,
      attached: 0,
      degraded: true,
      results: outcomes.map((r) => ({
        testCaseId: r.testCaseId,
        name: r.name,
        status: r.status,
        message: r.message,
        hasScreenshot: Boolean(r.screenshotPng),
        ...(squashIds.get(r.testCaseId) ? { squashCaseId: squashIds.get(r.testCaseId) } : {}),
        ...(r.steps ? { steps: r.steps } : {}),
      })),
    };
    return { summary, outputs: { sync } };
  }

  const synced = await syncCaseResultsToSquash({
    results: outcomes,
    workItem,
    squashIdForCase: async (testCaseId) => squashIds.get(testCaseId),
    upsert: writable.upsert,
    updateStatus: writable.updateStatus,
    uploadAttachment: writable.uploadAttachment,
  });

  if (deps.testCases && evidenceExecutionId) {
    await deps.testCases.completeWorkItemExecution(evidenceExecutionId, {
      status: 'completed',
      squashSync: synced.summary,
      results: synced.results,
    }).catch(() => undefined);
  }

  const syncedCount = countSynced(synced.results);
  const attached = countAttached(synced.summary);
  const sync = {
    summary: synced.summary,
    writable: true,
    synced: syncedCount,
    attached,
    degraded: isDegradedSummary(synced.summary, true),
    results: synced.results.map((r) => ({
      testCaseId: r.testCaseId,
      name: r.name,
      status: r.status,
      message: r.message,
      hasScreenshot: Boolean(r.screenshotPng),
      ...(squashIds.get(r.testCaseId) ? { squashCaseId: squashIds.get(r.testCaseId) } : {}),
      ...(r.squashExecutionId ? { squashExecutionId: r.squashExecutionId } : {}),
      ...(r.steps ? { steps: r.steps } : {}),
    })),
  };

  return {
    summary: summarizeUpdateSquash({
      writable: true,
      synced: syncedCount,
      summary: synced.summary,
      total: outcomes.length,
    }),
    outputs: { sync },
  };
}
