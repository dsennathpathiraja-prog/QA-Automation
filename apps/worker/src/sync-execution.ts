import { PlatformError } from '@qa/domain';
import type { CaseOutcome } from './run-work-item';

const SQUASH_STATUS: Record<CaseOutcome['status'], string> = {
  Passed: 'SUCCESS',
  Failed: 'FAILURE',
  Blocked: 'BLOCKED',
  Skipped: 'UNTESTABLE',
};

const TOKEN_FIX =
  'Replace credentials with a READ_WRITE personal API token (Authorization: Bearer only — not username/password), Test Connection, Switch on, and restart the worker so it picks up the new secret lease.';

/**
 * Writes each case result to Squash when the connector can create executions.
 * Uses project name resolution already configured on the Squash connector (for example ToolKit-AgenFlow).
 * Auth must match the create/publish path: Bearer token from the same leased secret bag.
 */
export async function syncCaseResultsToSquash(o: {
  results: CaseOutcome[];
  workItem: string;
  squashIdForCase: (testCaseId: string, name: string) => Promise<string | undefined>;
  upsert: (testCaseId: string) => Promise<{ id: string; created: boolean }>;
  updateStatus: (executionId: string, status: string, actualResult?: string) => Promise<void>;
}): Promise<{ results: CaseOutcome[]; summary: string }> {
  if (o.results.length === 0) return { results: o.results, summary: `No cases to sync for ${o.workItem}.` };
  const out: CaseOutcome[] = [];
  let synced = 0;
  let error = '';
  for (const row of o.results) {
    if (error) {
      out.push(row);
      continue;
    }
    try {
      const squashCaseId = await o.squashIdForCase(row.testCaseId, row.name);
      if (!squashCaseId) {
        out.push(row);
        if (!error) error = `No Squash case id for "${row.name}". Store cases in Squash on publish first.`;
        continue;
      }
      const execution = await o.upsert(squashCaseId);
      await o.updateStatus(execution.id, SQUASH_STATUS[row.status], row.message);
      out.push({ ...row, squashExecutionId: execution.id });
      synced += 1;
    } catch (e) {
      error = clarifySquashSyncError(e);
      out.push(row);
    }
  }
  if (error && synced === 0) return { results: out, summary: `Cases ran for ${o.workItem}. Squash was not updated: ${error}` };
  if (error) return { results: out, summary: `Cases ran for ${o.workItem}. Squash accepted ${synced} then stopped: ${error}` };
  return { results: out, summary: `Cases ran for ${o.workItem}. Squash recorded ${synced} execution status${synced === 1 ? '' : 'es'}.` };
}

/** Pulls a numeric Squash id from a Test Cases summary like "Squash 42". */
export function squashIdFromSummary(summary: string): string | undefined {
  const m = /^Squash (\d+)$/.exec(summary.trim());
  return m?.[1];
}

export function clarifySquashSyncError(e: unknown): string {
  const raw = e instanceof PlatformError ? e.message : 'Squash did not accept the execution status.';
  if (/read-only|cannot change|WRITE/i.test(raw) && !/READ_WRITE|personal API token/i.test(raw)) {
    return `The Squash connector cannot write execution status. ${TOKEN_FIX}`;
  }
  if (/rejected the API token|expired, revoked|not a token|Basic authentication|secret lease|Unauthorized/i.test(raw)) {
    if (/Test Connection|Switch on|restart the worker/i.test(raw)) return raw;
    return `${raw} ${TOKEN_FIX}`;
  }
  return raw;
}
