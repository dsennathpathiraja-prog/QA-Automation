import { PlatformError } from '@qa/domain';
import type { CaseOutcome } from './run-work-item';

const SQUASH_STATUS: Record<CaseOutcome['status'], string> = {
  Passed: 'SUCCESS',
  Failed: 'FAILURE',
  Blocked: 'BLOCKED',
  Skipped: 'UNTESTABLE',
};

/**
 * Writes each case result to Squash when the connector can create executions.
 * Uses project name resolution already configured on the Squash connector (for example ToolKit-AgenFlow).
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
      error = e instanceof PlatformError ? e.message : 'Squash did not accept the execution status.';
      if (/read-only|cannot change|WRITE/i.test(error)) {
        error = 'The Squash connector cannot write execution status. Use a READ_WRITE token and Switch on.';
      }
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
