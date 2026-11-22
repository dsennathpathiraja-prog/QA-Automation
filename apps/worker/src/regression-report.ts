import { PlatformError } from '@qa/domain';

export type FlowResult = { summary: string; outputs: Record<string, unknown> };

export type ReportCaseRow = {
  testCaseId: string;
  name: string;
  status: string;
  message: string;
  squashCaseId?: string;
  hasScreenshot?: boolean;
  squashExecutionId?: string;
  notAutomated?: boolean;
};

export type ReportTallies = {
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  notAutomated: number;
};

export type PreviousRegressionRun = {
  id: string;
  workItem: string;
  finishedAt?: string;
  environmentId?: string;
  results: ReportCaseRow[];
};

export type RegressionReportDeps = {
  /**
   * Optional previous completed Regression evidence run for the same environment.
   * When omitted / returns undefined, the report skips the compare section.
   */
  findPreviousRun?: (input: {
    runId: string;
    evidenceExecutionId?: string;
    environmentId?: string;
  }) => Promise<PreviousRegressionRun | undefined>;
};

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '');

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined);

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'run';

export function regressionReportArtifactPath(runId: string): string {
  return `reports/regression/${slug(runId)}.regression-report.md`;
}

export function isNotAutomatedMessage(message: string): boolean {
  return /Not Automated/i.test(message);
}

export function talliesFromResults(rows: ReportCaseRow[]): ReportTallies {
  const tallies: ReportTallies = { passed: 0, failed: 0, blocked: 0, skipped: 0, notAutomated: 0 };
  for (const row of rows) {
    if (row.notAutomated || (row.status === 'Skipped' && isNotAutomatedMessage(row.message))) {
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

export function parseReportCases(raw: unknown): ReportCaseRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportCaseRow[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const testCaseId = text(row.testCaseId);
    const name = text(row.name) || testCaseId;
    const status = text(row.status);
    if (!testCaseId || !status) continue;
    const message = text(row.message);
    out.push({
      testCaseId,
      name,
      status,
      message,
      ...(text(row.squashCaseId) ? { squashCaseId: text(row.squashCaseId) } : {}),
      ...(typeof row.hasScreenshot === 'boolean' ? { hasScreenshot: row.hasScreenshot } : {}),
      ...(text(row.squashExecutionId) ? { squashExecutionId: text(row.squashExecutionId) } : {}),
      notAutomated: status === 'Skipped' && isNotAutomatedMessage(message),
    });
  }
  return out;
}

export function compareRuns(current: ReportCaseRow[], previous: ReportCaseRow[]): Array<{
  name: string;
  squashCaseId?: string;
  from: string;
  to: string;
}> {
  const prevByKey = new Map<string, ReportCaseRow>();
  for (const row of previous) {
    prevByKey.set(row.squashCaseId || row.testCaseId || row.name, row);
  }
  const deltas: Array<{ name: string; squashCaseId?: string; from: string; to: string }> = [];
  for (const row of current) {
    const key = row.squashCaseId || row.testCaseId || row.name;
    const prior = prevByKey.get(key);
    if (!prior) continue;
    if (prior.status === row.status) continue;
    deltas.push({
      name: row.name,
      ...(row.squashCaseId ? { squashCaseId: row.squashCaseId } : {}),
      from: prior.status,
      to: row.status,
    });
  }
  return deltas.sort((a, b) => a.name.localeCompare(b.name));
}

function evidenceLink(o: {
  evidenceExecutionId?: string;
  testCaseId: string;
  hasScreenshot?: boolean;
}): string {
  if (!o.evidenceExecutionId) return o.hasScreenshot ? 'screenshot on platform' : '—';
  // Deep-link into the product Evidence / Report UI (not the raw screenshot JSON API).
  if (!o.hasScreenshot) return `[execution](/evidence?focus=${o.evidenceExecutionId})`;
  return `[screenshot](/evidence?focus=${o.evidenceExecutionId}&case=${o.testCaseId})`;
}

/** Deterministic Markdown artifact for a Regression run (optional previous-run compare). */
export function renderRegressionReportMarkdown(input: {
  runId: string;
  environmentName?: string;
  environmentId?: string;
  applicationUrl?: string;
  evidenceExecutionId?: string;
  syncSummary?: string;
  syncWritable?: boolean;
  syncDegraded?: boolean;
  results: ReportCaseRow[];
  compare?: {
    previousRunId: string;
    previousWorkItem?: string;
    previousFinishedAt?: string;
    deltas: Array<{ name: string; squashCaseId?: string; from: string; to: string }>;
    previousTallies: ReportTallies;
  };
}): string {
  const tallies = talliesFromResults(input.results);
  const lines: string[] = [
    `# Regression report: ${input.runId}`,
    '',
    '## Summary',
    '',
    `- **Run id:** ${input.runId}`,
    input.environmentName ? `- **Environment:** ${input.environmentName}` : '',
    input.applicationUrl ? `- **Application URL:** ${input.applicationUrl}` : '',
    input.evidenceExecutionId ? `- **Evidence execution:** \`${input.evidenceExecutionId}\`` : '',
    `- **Passed:** ${tallies.passed}`,
    `- **Failed:** ${tallies.failed}`,
    `- **Blocked:** ${tallies.blocked}`,
    `- **Skipped:** ${tallies.skipped}`,
    `- **Not Automated:** ${tallies.notAutomated}`,
    input.syncSummary
      ? `- **Squash sync:** ${input.syncSummary}${input.syncDegraded || input.syncWritable === false ? ' _(degraded)_' : ''}`
      : '- **Squash sync:** _(not recorded)_',
    '',
    '## Results',
    '',
    '| Case | Squash case | Status | Evidence | Message |',
    '| --- | --- | --- | --- | --- |',
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === ''));

  const sorted = [...input.results].sort((a, b) => {
    const sa = a.squashCaseId || a.name;
    const sb = b.squashCaseId || b.name;
    return sa.localeCompare(sb, undefined, { numeric: true });
  });
  for (const row of sorted) {
    const status = row.notAutomated ? 'Not Automated' : row.status;
    const msg = row.message.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(
      `| ${row.name.replace(/\|/g, '\\|')} | ${row.squashCaseId ?? '—'} | ${status} | ${evidenceLink({
        evidenceExecutionId: input.evidenceExecutionId,
        testCaseId: row.testCaseId,
        hasScreenshot: row.hasScreenshot,
      })} | ${msg || '—'} |`,
    );
  }

  if (input.compare) {
    lines.push(
      '',
      '## Compare to previous run',
      '',
      `- **Previous run:** ${input.compare.previousWorkItem ?? input.compare.previousRunId}`,
      input.compare.previousFinishedAt ? `- **Previous finished:** ${input.compare.previousFinishedAt}` : '',
      `- **Previous tallies:** Passed ${input.compare.previousTallies.passed}, Failed ${input.compare.previousTallies.failed}, Blocked ${input.compare.previousTallies.blocked}, Skipped ${input.compare.previousTallies.skipped}, Not Automated ${input.compare.previousTallies.notAutomated}`,
      '',
    );
    if (input.compare.deltas.length === 0) {
      lines.push('_No status changes versus the previous run._', '');
    } else {
      lines.push('| Case | Squash case | Previous | Current |', '| --- | --- | --- | --- |');
      for (const d of input.compare.deltas) {
        lines.push(`| ${d.name.replace(/\|/g, '\\|')} | ${d.squashCaseId ?? '—'} | ${d.from} | ${d.to} |`);
      }
      lines.push('');
    }
  }

  return `${lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n').trimEnd()}\n`;
}

export function summarizeRegressionReport(o: {
  tallies: ReportTallies;
  compared: boolean;
  deltaCount: number;
}): string {
  const parts = [
    o.tallies.passed > 0 ? `${o.tallies.passed} Passed` : '',
    o.tallies.failed > 0 ? `${o.tallies.failed} Failed` : '',
    o.tallies.blocked > 0 ? `${o.tallies.blocked} Blocked` : '',
    o.tallies.skipped > 0 ? `${o.tallies.skipped} Skipped` : '',
    o.tallies.notAutomated > 0 ? `${o.tallies.notAutomated} Not Automated` : '',
  ].filter(Boolean);
  const tally = parts.length > 0 ? parts.join(', ') : 'no results';
  if (!o.compared) return `Regression report written (${tally}).`;
  if (o.deltaCount === 0) return `Regression report written (${tally}); compared to previous run — no status changes.`;
  return `Regression report written (${tally}); compared to previous run — ${o.deltaCount} status change${o.deltaCount === 1 ? '' : 's'}.`;
}

/**
 * Phase 9 E5 — `rg.regression-report`: deterministic `regression-report.md` (+ optional previous-run compare).
 */
export async function performRegressionReport(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  deps: RegressionReportDeps = {},
): Promise<FlowResult> {
  if (step.type !== 'rg.regression-report') {
    throw new PlatformError('internal', `performRegressionReport does not handle ${step.type}`);
  }

  const priorExecute = step.prior.execute ?? {};
  const priorUpdate = step.prior.update_squash ?? {};
  const rawResults = Array.isArray(priorExecute.results)
    ? priorExecute.results
    : Array.isArray(step.params.results)
      ? step.params.results
      : [];
  const results = parseReportCases(rawResults);

  const syncBag = asRecord(priorUpdate.sync) ?? asRecord(step.params.sync);
  const syncSummary = text(syncBag?.summary) || (typeof step.params.sync === 'string' ? text(step.params.sync) : '');
  const syncWritable = typeof syncBag?.writable === 'boolean' ? syncBag.writable : undefined;
  const syncDegraded = typeof syncBag?.degraded === 'boolean' ? syncBag.degraded : undefined;

  const env = asRecord(priorExecute.environment) ?? asRecord(step.params.environment);
  const evidenceExecutionId = text(priorExecute.evidenceExecutionId) || text(step.params.evidenceExecutionId) || undefined;
  const environmentId = text(env?.id) || undefined;

  let compare: {
    previousRunId: string;
    previousWorkItem?: string;
    previousFinishedAt?: string;
    deltas: Array<{ name: string; squashCaseId?: string; from: string; to: string }>;
    previousTallies: ReportTallies;
  } | undefined;

  if (deps.findPreviousRun) {
    const previous = await deps.findPreviousRun({
      runId: step.runId,
      evidenceExecutionId,
      environmentId,
    });
    if (previous) {
      const previousTallies = talliesFromResults(previous.results);
      compare = {
        previousRunId: previous.id,
        previousWorkItem: previous.workItem,
        previousFinishedAt: previous.finishedAt,
        previousTallies,
        deltas: compareRuns(results, previous.results),
      };
    }
  }

  const tallies = talliesFromResults(results);
  const artifactMarkdown = renderRegressionReportMarkdown({
    runId: step.runId,
    environmentName: text(env?.name) || undefined,
    environmentId,
    applicationUrl: text(env?.applicationUrl) || undefined,
    evidenceExecutionId,
    syncSummary: syncSummary || undefined,
    syncWritable,
    syncDegraded,
    results,
    compare,
  });
  const artifactPath = regressionReportArtifactPath(step.runId);
  const summary = summarizeRegressionReport({
    tallies,
    compared: !!compare,
    deltaCount: compare?.deltas.length ?? 0,
  });

  return {
    summary,
    outputs: {
      artifactMarkdown,
      artifactPath,
      tallies,
      syncSummary: syncSummary || undefined,
      ...(compare
        ? {
          compare: {
            previousRunId: compare.previousRunId,
            previousWorkItem: compare.previousWorkItem,
            deltaCount: compare.deltas.length,
            deltas: compare.deltas,
          },
        }
        : {}),
    },
  };
}
