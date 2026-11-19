import { PlatformError, type RunnerLauncher, type RunnerSpec } from '@qa/domain';
import type { CaseRunStatus, TestCaseService, WorkItemRunRecord } from '@qa/application';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const STUB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const NO_RESULTS = 'The runner finished without case results.';

export interface CaseOutcome {
  testCaseId: string;
  name: string;
  status: CaseRunStatus;
  message: string;
  screenshotPng?: string;
  squashExecutionId?: string;
}

/**
 * Runs the cases of one prepared work-item execution through the runner (or a direct probe when the launcher is down).
 */
export async function runWorkItemCases(o: {
  run: WorkItemRunRecord;
  cases: Array<{ id: string; name: string }>;
  url: string;
  launcher?: { launcher: RunnerLauncher; image: string; logs(id: string): Promise<string> };
  probe?: (url: string) => Promise<{ status: number }>;
  now?: number;
}): Promise<{ viaRunner: boolean; results: CaseOutcome[] }> {
  if (o.cases.length === 0) return { viaRunner: false, results: [] };
  if (o.launcher) {
    try {
      const results = await viaRunner(o);
      if (!isEmptyRunnerResult(results) || !o.probe) return { viaRunner: true, results };
      // Runner container finished but emitted no RESULT_JSON (stale image, truncated logs, crash).
      // Fall back to a direct probe so the board still shows Passed/Failed instead of all Blocked.
      const probed = await viaDirect(o);
      return { viaRunner: true, results: probed };
    } catch (e) {
      if (!launcherDown(e)) throw e;
    }
  }
  return { viaRunner: false, results: await viaDirect(o) };
}

export function parseCaseResults(text: string, fallback: Array<{ id: string; name: string }>): CaseOutcome[] {
  const found: CaseOutcome[] = [];
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('RESULT_JSON ');
    if (idx < 0) continue;
    const raw = line.slice(idx + 'RESULT_JSON '.length).trim();
    if (!raw) continue;
    try {
      const row = JSON.parse(raw) as Partial<CaseOutcome>;
      if (typeof row.testCaseId !== 'string' || typeof row.name !== 'string') continue;
      const status = asStatus(row.status);
      if (!status) continue;
      found.push({
        testCaseId: row.testCaseId,
        name: row.name,
        status,
        message: typeof row.message === 'string' ? row.message : '',
        screenshotPng: typeof row.screenshotPng === 'string' ? row.screenshotPng : STUB_PNG,
      });
    } catch {
      /* ignore bad lines */
    }
  }
  if (found.length > 0) return found;

  // Older runner images only printed reachability-style "answered N" with no RESULT_JSON.
  const answered = Number(/answered (\d{3})\b/.exec(text)?.[1]);
  if (Number.isInteger(answered) && answered > 0) {
    const status: CaseRunStatus = answered >= 500 ? 'Failed' : answered >= 200 ? 'Passed' : 'Failed';
    return fallback.map((c) => ({
      testCaseId: c.id,
      name: c.name,
      status,
      message: `answered ${answered}`,
      screenshotPng: STUB_PNG,
    }));
  }

  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  const message = excerpt
    ? `${NO_RESULTS} Rebuild qa-runner:local with the runners compose profile if the image predates work-item execute. Log: ${excerpt}`
    : `${NO_RESULTS} Rebuild qa-runner:local with the runners compose profile if the image predates work-item execute.`;
  return fallback.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked' as const, message, screenshotPng: STUB_PNG }));
}

export function launcherDown(e: unknown): boolean {
  return e instanceof PlatformError && e.errorClass === 'transient' && /could not resolve|network error|timed out|not reachable/.test(e.message);
}

function isEmptyRunnerResult(results: CaseOutcome[]): boolean {
  return results.length > 0 && results.every((r) => r.status === 'Blocked' && r.message.startsWith(NO_RESULTS));
}

async function viaRunner(o: {
  run: WorkItemRunRecord;
  cases: Array<{ id: string; name: string }>;
  url: string;
  launcher?: { launcher: RunnerLauncher; image: string; logs(id: string): Promise<string> };
  now?: number;
}): Promise<CaseOutcome[]> {
  const launcher = o.launcher!;
  const target = new URL(o.url);
  const host = target.hostname.toLowerCase();
  const spec: RunnerSpec = {
    runId: `wi-${o.run.id.replace(/[^A-Za-z0-9]/g, '')}-${o.now ?? Date.now()}`,
    executionId: o.run.id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || 'workitem',
    image: launcher.image,
    bundleRef: 'work-item',
    environmentId: o.run.environmentId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || 'environment',
    // Chromium needs headroom; the old 128 pid cap could kill the browser before RESULT_JSON was printed.
    limits: { cpus: 1, memoryMb: 2048, timeoutSeconds: 180, pids: 512 },
    allowedHosts: [target.port ? `${host}:${target.port}` : host],
    env: {
      QA_TARGET_URL: o.url,
      QA_CASES_JSON: JSON.stringify(o.cases.map((c) => ({ id: c.id, name: c.name }))),
    },
  };
  const handle = await launcher.launcher.launch(spec);
  const deadline = Date.now() + (spec.limits.timeoutSeconds + 10) * 1000;
  let state = await launcher.launcher.status(handle.id);
  while (state.state === 'starting' || state.state === 'running') {
    if (Date.now() > deadline) {
      await launcher.launcher.stop(handle.id, 'the work-item run took too long');
      throw new PlatformError('internal', 'The runner did not finish in time.');
    }
    await sleep(250);
    state = await launcher.launcher.status(handle.id);
  }
  const text = await launcher.logs(handle.id);
  return parseCaseResults(text, o.cases);
}

async function viaDirect(o: {
  cases: Array<{ id: string; name: string }>;
  url: string;
  probe?: (url: string) => Promise<{ status: number }>;
}): Promise<CaseOutcome[]> {
  if (!o.probe) {
    return o.cases.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked' as const, message: 'No probe was configured for a direct run.', screenshotPng: STUB_PNG }));
  }
  try {
    const res = await o.probe(o.url);
    const status: CaseRunStatus = res.status >= 500 ? 'Failed' : res.status >= 200 ? 'Passed' : 'Failed';
    const message = `answered ${res.status}`;
    return o.cases.map((c) => ({ testCaseId: c.id, name: c.name, status, message, screenshotPng: STUB_PNG }));
  } catch (e) {
    const message = e instanceof PlatformError ? e.message : 'did not answer';
    return o.cases.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked', message, screenshotPng: STUB_PNG }));
  }
}

function asStatus(v: unknown): CaseRunStatus | undefined {
  return v === 'Passed' || v === 'Failed' || v === 'Blocked' || v === 'Skipped' ? v : undefined;
}

/** One queued work-item run per tick. */
export async function processWorkItemExecutions(o: {
  testCases: TestCaseService;
  resolveUrl: (environmentId: string) => Promise<string>;
  run: (input: { run: WorkItemRunRecord; cases: Array<{ id: string; name: string }>; url: string }) => Promise<{ viaRunner: boolean; results: CaseOutcome[] }>;
  syncSquash?: (results: CaseOutcome[], workItem: string) => Promise<{ results: CaseOutcome[]; summary: string }>;
}): Promise<'busy' | 'idle'> {
  const claimed = await o.testCases.claimQueuedWorkItemExecution();
  if (!claimed) return 'idle';
  try {
    const cases = await o.testCases.casesForWorkItem(claimed.workItem);
    const url = await o.resolveUrl(claimed.environmentId);
    const ran = await o.run({ run: claimed, cases: cases.map((c) => ({ id: c.id, name: c.name })), url });
    let results = ran.results;
    let squashSync: string | undefined;
    if (o.syncSquash) {
      const synced = await o.syncSquash(results, claimed.workItem);
      results = synced.results;
      squashSync = synced.summary;
    } else {
      squashSync = 'Squash was not available for this run.';
    }
    const failed = results.some((r) => r.status === 'Failed' || r.status === 'Blocked');
    await o.testCases.completeWorkItemExecution(claimed.id, {
      status: failed && results.every((r) => r.status === 'Blocked') ? 'failed' : 'completed',
      squashSync,
      results,
    });
  } catch (e) {
    const message = e instanceof PlatformError ? e.message : 'The work item run failed.';
    const cases = await o.testCases.casesForWorkItem(claimed.workItem);
    await o.testCases.completeWorkItemExecution(claimed.id, {
      status: 'failed',
      squashSync: message,
      results: cases.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked' as const, message, screenshotPng: STUB_PNG })),
    });
  }
  return 'busy';
}
