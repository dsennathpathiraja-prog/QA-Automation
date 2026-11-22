import { markdownFromStepPayload } from '../StepArtifact';

export type ExecutionEventRow = {
  seq: number;
  kind: string;
  at: string;
  payload: Record<string, unknown>;
};

export type WorkItemCaseRow = {
  id: string;
  testCaseId: string;
  name: string;
  status: string;
  message: string;
  hasScreenshot: boolean;
  squashExecutionId?: string;
  steps?: Array<{ name: string; status: string }>;
};

export type WorkItemRun = {
  id: string;
  workItem: string;
  environmentId: string;
  environmentName: string;
  caseCount: number;
  status: string;
  createdAt: string;
  finishedAt?: string;
  squashSync?: string;
  counts?: {
    total: number;
    queued: number;
    running: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    completed: number;
  };
  results?: WorkItemCaseRow[];
};

export const CASE_CHIP: Record<string, 'default' | 'success' | 'error' | 'warning' | 'info'> = {
  Queued: 'default',
  Running: 'info',
  Passed: 'success',
  Failed: 'error',
  Blocked: 'warning',
  Skipped: 'default',
};

export const WI_STATUS: Record<string, string> = {
  prepared: 'Prepared',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const WI_LIVE = new Set(['queued', 'running']);

export type RunDetailView = 'summary' | 'report' | 'evidence';

export function parseRunDetailView(raw: unknown): RunDetailView {
  if (raw === 'report' || raw === 'evidence' || raw === 'summary') return raw;
  return 'summary';
}

/** Regression evidence rows are labeled `rg:<workflowRunId>`. */
export function workflowRunIdFromWorkItem(workItem: string): string | null {
  if (!workItem.startsWith('rg:')) return null;
  const id = workItem.slice(3).trim();
  return id || null;
}

export type ReportArtifact = {
  markdown: string;
  path: string;
  tallies?: {
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    notAutomated: number;
  };
  syncSummary?: string;
};

/** Pull the `rg.regression-report` Markdown artifact from workflow step events. */
export function findRegressionReport(events: ExecutionEventRow[] | undefined): ReportArtifact | null {
  if (!events) return null;
  for (const event of events) {
    if (event.kind !== 'step.completed') continue;
    const stepType = String(event.payload.stepType ?? '');
    const stepId = String(event.payload.stepId ?? '');
    const artifact = markdownFromStepPayload(event.payload);
    const isReport = stepType === 'rg.regression-report'
      || /regression-report/i.test(stepId)
      || (artifact?.path.includes('regression-report') ?? false);
    if (!isReport || !artifact) continue;
    const outputs = event.payload.outputs;
    const out = outputs && typeof outputs === 'object' && !Array.isArray(outputs)
      ? outputs as Record<string, unknown>
      : undefined;
    const talliesRaw = out?.tallies;
    let tallies: ReportArtifact['tallies'];
    if (talliesRaw && typeof talliesRaw === 'object' && !Array.isArray(talliesRaw)) {
      const t = talliesRaw as Record<string, unknown>;
      tallies = {
        passed: Number(t.passed) || 0,
        failed: Number(t.failed) || 0,
        blocked: Number(t.blocked) || 0,
        skipped: Number(t.skipped) || 0,
        notAutomated: Number(t.notAutomated) || 0,
      };
    }
    const syncSummary = typeof out?.syncSummary === 'string' ? out.syncSummary : undefined;
    return { ...artifact, ...(tallies ? { tallies } : {}), ...(syncSummary ? { syncSummary } : {}) };
  }
  return null;
}

/** Prefer execute-step `evidenceExecutionId` when present on workflow events. */
export function findEvidenceExecutionId(events: ExecutionEventRow[] | undefined): string | null {
  if (!events) return null;
  for (const event of [...events].reverse()) {
    if (event.kind !== 'step.completed') continue;
    const outputs = event.payload.outputs;
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) continue;
    const id = (outputs as Record<string, unknown>).evidenceExecutionId;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

export function talliesFromCaseResults(results: Array<{ status: string; message?: string }> | undefined): {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  notAutomated: number;
} {
  const tallies = { passed: 0, failed: 0, blocked: 0, skipped: 0, notAutomated: 0 };
  for (const row of results ?? []) {
    if (row.status === 'Skipped' && /Not Automated/i.test(row.message ?? '')) {
      tallies.notAutomated += 1;
      continue;
    }
    if (row.status === 'Passed') tallies.passed += 1;
    else if (row.status === 'Failed') tallies.failed += 1;
    else if (row.status === 'Blocked') tallies.blocked += 1;
    else if (row.status === 'Skipped') tallies.skipped += 1;
  }
  return tallies;
}

/** Sync line: info when Squash accepted status/attachments; warning when status or screenshots degraded. */
export function squashSyncAlertSeverity(message: string): 'info' | 'warning' {
  if (/Squash was not updated|No writable Squash|was not available|Screenshot attachments were not uploaded|then stopped:/i.test(message)) {
    return 'warning';
  }
  return 'info';
}

export function screenshotEmptyHint(message: string | undefined): string {
  const m = message ?? '';
  if (/pool is full|pool stayed full/i.test(m)) {
    return 'No screenshot: the runner pool was full. In PowerShell, reclaim leftovers with docker ps -a --filter "label=qa.platform/managed=true" then docker rm -f on those ids, or raise RUNNER_MAX_CONCURRENT, then re-run.';
  }
  if (/runner-launcher is not available|Playwright runner|runner image qa-runner/i.test(m)) {
    return 'No screenshot: the Playwright runner was not available. In PowerShell from the repo root: docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d, then re-run.';
  }
  if (/HTTP probe|runner-launcher unavailable|runner returned no RESULT_JSON/i.test(m)) {
    return 'No screenshot: this case did not run through Playwright. Rebuild and start the local runner stack, then re-run.';
  }
  if (/no screenshot/i.test(m)) {
    return m.includes('·') ? m.slice(m.indexOf('·') + 1).trim() : 'No screenshot was captured for this case.';
  }
  return 'No screenshot was captured for this case. Rebuild qa-runner:local with the local compose stack, then re-run so Playwright can capture evidence.';
}

export function countsLabel(item: {
  caseCount: number;
  counts?: { completed: number; passed: number; failed: number; running: number; queued: number };
}): string {
  if (!item.counts) return `${item.caseCount} ${item.caseCount === 1 ? 'case' : 'cases'}`;
  const { completed, passed, failed, running, queued } = item.counts;
  return `${completed}/${item.caseCount} done · ${passed} passed · ${failed} failed${running ? ` · ${running} running` : ''}${queued ? ` · ${queued} queued` : ''}`;
}
