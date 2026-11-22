import { PlatformError, RUNNER_INLINE_FILES_MAX_BYTES, RUNNER_MAX, type RunnerLauncher, type RunnerSpec } from '@qa/domain';
import { isPlaceholderScreenshot, type CaseRunStatus, type CaseStepProgress, type TestCaseService, type WorkItemRunRecord } from '@qa/application';

/** Injected into the runner via launcher putFiles (tmpfs) — not env (4096-byte cap). */
const CASES_FILE = '/tmp/qa-cases.json';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_RESULTS = 'The runner finished without case results.';
/** Shown when Executions cannot use Playwright (no silent HTTP “Passed” without evidence). */
export const RUNNER_REQUIRED =
  'Playwright runner-launcher is not available. Start the local stack so runner-launcher and qa-runner:local are up (`docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d`), then re-run.';

function realScreenshot(b64: string | undefined): string | undefined {
  return b64 && !isPlaceholderScreenshot(b64) ? b64 : undefined;
}

function blockedRunnerRequired(cases: WorkItemCaseInput[]): CaseOutcome[] {
  return cases.map((c) => ({
    testCaseId: c.id,
    name: c.name,
    status: 'Blocked' as const,
    message: RUNNER_REQUIRED,
    steps: defaultSteps(c.steps, 'Blocked'),
  }));
}

export interface CaseOutcome {
  testCaseId: string;
  name: string;
  status: CaseRunStatus;
  message: string;
  screenshotPng?: string;
  squashExecutionId?: string;
  steps?: CaseStepProgress[];
}

export interface WorkItemCaseInput {
  id: string;
  name: string;
  steps?: string;
}

/**
 * Runs prepared work-item cases through the Playwright runner only.
 * Never HTTP probe-falls back to a fake Passed without screenshots (QA-54).
 */
export async function runWorkItemCases(o: {
  run: WorkItemRunRecord;
  cases: WorkItemCaseInput[];
  url: string;
  launcher?: { launcher: RunnerLauncher; image: string; logs(id: string): Promise<string> };
  now?: number;
  onProgress?: (results: CaseOutcome[]) => Promise<void> | void;
}): Promise<{ viaRunner: boolean; results: CaseOutcome[] }> {
  if (o.cases.length === 0) return { viaRunner: false, results: [] };
  if (!o.launcher) {
    const results = blockedRunnerRequired(o.cases);
    if (o.onProgress) await o.onProgress(results);
    return { viaRunner: false, results };
  }
  try {
    const results = await viaRunner(o);
    return { viaRunner: true, results };
  } catch (e) {
    if (!launcherDown(e)) throw e;
    const results = blockedRunnerRequired(o.cases);
    if (o.onProgress) await o.onProgress(results);
    return { viaRunner: false, results };
  }
}

export function parseCaseResults(text: string, fallback: WorkItemCaseInput[]): CaseOutcome[] {
  const found = parseResultLines(text);
  if (found.length > 0) return attachScreenshots(found, text);

  // Truncated RESULT_JSON used to put huge base64 before status/message; do not treat fragments as a
  // clean legacy reachability log — that hid missing screenshots behind a probe fallback.
  if (/\bRESULT_JSON\b|\bSCREENSHOT_JSON\b|\bRUNNER_MODE\b|\bPROGRESS_JSON\b/.test(text)) {
    const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    const rebuild = 'Rebuild qa-runner:local with: docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d';
    const message = excerpt
      ? `${NO_RESULTS} Runner log markers were present but RESULT_JSON could not be parsed (often a truncated log line). ${rebuild}. Log: ${excerpt}`
      : `${NO_RESULTS} Runner log markers were present but RESULT_JSON could not be parsed. ${rebuild}.`;
    return fallback.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked' as const, message, steps: defaultSteps(c.steps, 'Blocked') }));
  }

  // Older runner images only printed reachability-style "answered N" with no RESULT_JSON.
  const answered = Number(/answered (\d{3})\b/.exec(text)?.[1]);
  if (Number.isInteger(answered) && answered > 0) {
    const status: CaseRunStatus = answered >= 500 ? 'Failed' : answered >= 200 ? 'Passed' : 'Failed';
    return fallback.map((c) => ({
      testCaseId: c.id,
      name: c.name,
      status,
      message: `answered ${answered}`,
      steps: defaultSteps(c.steps, status === 'Passed' ? 'Passed' : 'Failed'),
    }));
  }

  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  const rebuild = 'Rebuild qa-runner:local with: docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d';
  const message = excerpt
    ? `${NO_RESULTS} ${rebuild} if the image predates work-item execute. Log: ${excerpt}`
    : `${NO_RESULTS} ${rebuild} if the image predates work-item execute.`;
  return fallback.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked' as const, message, steps: defaultSteps(c.steps, 'Blocked') }));
}

/** Merge seeded placeholders with PROGRESS_JSON / RESULT_JSON / SCREENSHOT_JSON lines for live UI updates. */
export function mergeLiveProgress(text: string, seeded: CaseOutcome[]): CaseOutcome[] {
  const byId = new Map(seeded.map((row) => [row.testCaseId, { ...row, steps: row.steps?.map((s) => ({ ...s })) }]));
  for (const line of text.split(/\r?\n/)) {
    const progressIdx = line.indexOf('PROGRESS_JSON ');
    if (progressIdx >= 0) {
      const raw = line.slice(progressIdx + 'PROGRESS_JSON '.length).trim();
      try {
        const row = JSON.parse(raw) as Partial<CaseOutcome> & { stepIndex?: number; stepStatus?: CaseRunStatus };
        if (typeof row.testCaseId !== 'string') continue;
        const current: CaseOutcome = byId.get(row.testCaseId) ?? {
          testCaseId: row.testCaseId,
          name: typeof row.name === 'string' ? row.name : row.testCaseId,
          status: 'Queued' as const,
          message: '',
          steps: undefined,
          screenshotPng: undefined,
        };
        const status = asStatus(row.status) ?? current.status;
        const steps = mergeStepProgress(current.steps, row.steps, row.stepIndex, row.stepStatus);
        byId.set(row.testCaseId, {
          ...current,
          name: typeof row.name === 'string' ? row.name : current.name,
          status,
          message: typeof row.message === 'string' ? row.message : current.message,
          steps: steps ?? current.steps,
          screenshotPng: realScreenshot(typeof row.screenshotPng === 'string' ? row.screenshotPng : current.screenshotPng),
        });
      } catch {
        /* ignore bad progress lines */
      }
      continue;
    }
    const shotIdx = line.indexOf('SCREENSHOT_JSON ');
    if (shotIdx >= 0) {
      const raw = line.slice(shotIdx + 'SCREENSHOT_JSON '.length).trim();
      try {
        const row = JSON.parse(raw) as { testCaseId?: string; screenshotPng?: string };
        if (typeof row.testCaseId !== 'string') continue;
        const shot = realScreenshot(typeof row.screenshotPng === 'string' ? row.screenshotPng : undefined);
        if (!shot) continue;
        const current = byId.get(row.testCaseId) ?? {
          testCaseId: row.testCaseId,
          name: row.testCaseId,
          status: 'Running' as const,
          message: '',
          steps: undefined,
        };
        byId.set(row.testCaseId, { ...current, screenshotPng: shot });
      } catch {
        /* ignore bad screenshot lines */
      }
      continue;
    }
    const resultIdx = line.indexOf('RESULT_JSON ');
    if (resultIdx < 0) continue;
    const raw = line.slice(resultIdx + 'RESULT_JSON '.length).trim();
    if (!raw) continue;
    try {
      const row = JSON.parse(raw) as Partial<CaseOutcome>;
      if (typeof row.testCaseId !== 'string' || typeof row.name !== 'string') continue;
      const status = asStatus(row.status);
      if (!status || status === 'Queued' || status === 'Running') continue;
      const prior = byId.get(row.testCaseId);
      byId.set(row.testCaseId, {
        testCaseId: row.testCaseId,
        name: row.name,
        status,
        message: typeof row.message === 'string' ? row.message : '',
        screenshotPng: realScreenshot(typeof row.screenshotPng === 'string' ? row.screenshotPng : prior?.screenshotPng),
        // Prefer seeded/full step labels when present; runner may only send compact Open/Capture names.
        steps: prior?.steps?.length ? markStepsDone(prior.steps, status) : Array.isArray(row.steps) ? parseSteps(row.steps) : markStepsDone(prior?.steps, status),
        squashExecutionId: prior?.squashExecutionId,
      });
    } catch {
      /* ignore bad result lines */
    }
  }
  return seeded.map((row) => byId.get(row.testCaseId) ?? row).concat([...byId.values()].filter((row) => !seeded.some((s) => s.testCaseId === row.testCaseId)));
}

export function launcherDown(e: unknown): boolean {
  return e instanceof PlatformError && e.errorClass === 'transient' && /could not resolve|network error|timed out|not reachable/.test(e.message);
}

/** Compact case payloads for the runner (id/name + short labels). Full step text stays in UI seed. */
export function compactCasesForRunner(cases: WorkItemCaseInput[]): Array<{ id: string; name: string; steps: string[] }> {
  return cases.map((c) => ({
    id: c.id,
    name: c.name.length > 240 ? `${c.name.slice(0, 237)}...` : c.name,
    steps: ['Open page', 'Capture evidence'],
  }));
}

async function viaRunner(o: {
  run: WorkItemRunRecord;
  cases: WorkItemCaseInput[];
  url: string;
  launcher?: { launcher: RunnerLauncher; image: string; logs(id: string): Promise<string> };
  now?: number;
  onProgress?: (results: CaseOutcome[]) => Promise<void> | void;
}): Promise<CaseOutcome[]> {
  const launcher = o.launcher!;
  const target = new URL(o.url);
  const host = target.hostname.toLowerCase();
  const seeded = o.cases.map((c) => ({
    testCaseId: c.id,
    name: c.name,
    status: 'Queued' as const,
    message: 'Waiting to run',
    steps: defaultSteps(c.steps, 'Queued'),
  }));
  const casesJson = JSON.stringify(compactCasesForRunner(o.cases));
  const casesBytes = Buffer.byteLength(casesJson, 'utf8');
  if (casesBytes > RUNNER_INLINE_FILES_MAX_BYTES) {
    throw new PlatformError(
      'validation',
      `This work item’s case list is ${casesBytes} bytes and exceeds the ${RUNNER_INLINE_FILES_MAX_BYTES} byte runner input limit. Split the collection or shorten case names, then re-run.`,
    );
  }
  // Per-case Playwright open+shot; scale wall clock for large prepared sets (hundreds of cases).
  const timeoutSeconds = Math.min(RUNNER_MAX.timeoutSeconds, Math.max(180, 90 + o.cases.length * 25));
  const spec: RunnerSpec = {
    runId: `wi-${o.run.id.replace(/[^A-Za-z0-9]/g, '')}-${o.now ?? Date.now()}`,
    executionId: o.run.id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || 'workitem',
    image: launcher.image,
    bundleRef: 'work-item',
    environmentId: o.run.environmentId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || 'environment',
    // Chromium needs headroom; the old 128 pid cap could kill the browser before RESULT_JSON was printed.
    limits: { cpus: 1, memoryMb: 2048, timeoutSeconds, pids: 512 },
    allowedHosts: [target.port ? `${host}:${target.port}` : host],
    env: {
      QA_TARGET_URL: o.url,
      QA_CASES_FILE: CASES_FILE,
    },
    inlineFiles: [{ path: CASES_FILE, content: casesJson }],
  };
  const handle = await launcher.launcher.launch(spec);
  const deadline = Date.now() + (spec.limits.timeoutSeconds + 10) * 1000;
  let state = await launcher.launcher.status(handle.id);
  let lastFingerprint = '';
  while (state.state === 'starting' || state.state === 'running') {
    if (Date.now() > deadline) {
      await launcher.launcher.stop(handle.id, 'the work-item run took too long');
      throw new PlatformError('internal', 'The runner did not finish in time.');
    }
    if (o.onProgress) {
      try {
        const partial = await launcher.logs(handle.id);
        const merged = mergeLiveProgress(partial, seeded);
        const fingerprint = merged
          .map((r) => `${r.testCaseId}:${r.status}:${r.message}:${r.screenshotPng?.length ?? 0}:${r.steps?.map((s) => s.status).join(',') ?? ''}`)
          .join('|');
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          await o.onProgress(merged);
        }
      } catch {
        /* log tail can race while the container is starting */
      }
    }
    await sleep(250);
    state = await launcher.launcher.status(handle.id);
  }
  const text = await launcher.logs(handle.id);
  const live = mergeLiveProgress(text, seeded);
  const finalResults = parseCaseResults(text, o.cases).map((row) => {
    const prior = seeded.find((s) => s.testCaseId === row.testCaseId);
    const fromLive = live.find((s) => s.testCaseId === row.testCaseId);
    return {
      ...row,
      // Prefer freshly parsed shot; keep any shot already merged from SCREENSHOT_JSON during the run.
      screenshotPng: row.screenshotPng ?? fromLive?.screenshotPng,
      // Keep seeded step labels (full case text); runner only sends compact Open/Capture labels.
      steps: markStepsDone(prior?.steps, row.status) ?? row.steps,
    };
  });
  if (o.onProgress) await o.onProgress(finalResults);
  return finalResults;
}

function parseResultLines(text: string): CaseOutcome[] {
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
      if (!status || status === 'Queued' || status === 'Running') continue;
      found.push({
        testCaseId: row.testCaseId,
        name: row.name,
        status,
        message: typeof row.message === 'string' ? row.message : '',
        screenshotPng: realScreenshot(typeof row.screenshotPng === 'string' ? row.screenshotPng : undefined),
        steps: Array.isArray(row.steps) ? parseSteps(row.steps) : undefined,
      });
    } catch {
      /* ignore bad lines */
    }
  }
  return found;
}

function parseScreenshotLines(text: string): Map<string, string> {
  const shots = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('SCREENSHOT_JSON ');
    if (idx < 0) continue;
    const raw = line.slice(idx + 'SCREENSHOT_JSON '.length).trim();
    if (!raw) continue;
    try {
      const row = JSON.parse(raw) as { testCaseId?: string; screenshotPng?: string };
      if (typeof row.testCaseId !== 'string') continue;
      const shot = realScreenshot(typeof row.screenshotPng === 'string' ? row.screenshotPng : undefined);
      if (shot) shots.set(row.testCaseId, shot);
    } catch {
      /* ignore bad screenshot lines */
    }
  }
  return shots;
}

function attachScreenshots(rows: CaseOutcome[], text: string): CaseOutcome[] {
  const shots = parseScreenshotLines(text);
  if (shots.size === 0) return rows;
  return rows.map((row) => ({
    ...row,
    screenshotPng: row.screenshotPng ?? shots.get(row.testCaseId),
  }));
}

function defaultSteps(stepsText: string | undefined, fill: CaseStepProgress['status']): CaseStepProgress[] {
  const lines = (stepsText ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const names = lines.length > 0 ? lines : ['Open page', 'Capture evidence'];
  return names.map((name) => ({ name, status: fill }));
}

function parseSteps(raw: unknown): CaseStepProgress[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CaseStepProgress[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof (item as { name?: unknown }).name === 'string'
      ? (item as { name: string }).name
      : typeof item === 'string'
        ? item
        : '';
    const status = asStatus((item as { status?: unknown }).status) ?? 'Queued';
    if (!name) continue;
    out.push({ name, status });
  }
  return out.length > 0 ? out : undefined;
}

/** Keep seeded/full step names; copy status from compact runner progress by index when possible. */
function mergeStepProgress(
  current: CaseStepProgress[] | undefined,
  incoming: unknown,
  stepIndex: unknown,
  stepStatus: unknown,
): CaseStepProgress[] | undefined {
  if (current?.length && Array.isArray(incoming)) {
    return current.map((step, i) => {
      const row = incoming[i];
      const next = row && typeof row === 'object' ? asStatus((row as { status?: unknown }).status) : undefined;
      return next ? { ...step, status: next } : step;
    });
  }
  if (Array.isArray(incoming)) return parseSteps(incoming);
  return applyStepIndex(current, stepIndex, stepStatus);
}

function applyStepIndex(steps: CaseStepProgress[] | undefined, stepIndex: unknown, stepStatus: unknown): CaseStepProgress[] | undefined {
  if (!steps || typeof stepIndex !== 'number' || stepIndex < 0 || stepIndex >= steps.length) return steps;
  const status = asStatus(stepStatus);
  if (!status) return steps;
  return steps.map((step, i) => {
    if (i < stepIndex) return { ...step, status: step.status === 'Queued' || step.status === 'Running' ? 'Passed' : step.status };
    if (i === stepIndex) return { ...step, status };
    return step;
  });
}

function markStepsDone(steps: CaseStepProgress[] | undefined, status: CaseRunStatus): CaseStepProgress[] | undefined {
  if (!steps) return undefined;
  const fill: CaseStepProgress['status'] = status === 'Passed' ? 'Passed' : status === 'Skipped' ? 'Skipped' : status === 'Failed' ? 'Failed' : status === 'Blocked' ? 'Blocked' : 'Passed';
  return steps.map((s) => ({ ...s, status: fill }));
}

function asStatus(v: unknown): CaseRunStatus | undefined {
  return v === 'Queued' || v === 'Running' || v === 'Passed' || v === 'Failed' || v === 'Blocked' || v === 'Skipped' ? v : undefined;
}

/** One queued work-item run per tick. */
export async function processWorkItemExecutions(o: {
  testCases: TestCaseService;
  resolveUrl: (environmentId: string) => Promise<string>;
  run: (input: {
    run: WorkItemRunRecord;
    cases: Array<{ id: string; name: string; steps?: string }>;
    url: string;
    onProgress?: (results: CaseOutcome[]) => Promise<void> | void;
  }) => Promise<{ viaRunner: boolean; results: CaseOutcome[] }>;
  syncSquash?: (results: CaseOutcome[], workItem: string) => Promise<{ results: CaseOutcome[]; summary: string }>;
}): Promise<'busy' | 'idle'> {
  const claimed = await o.testCases.claimQueuedWorkItemExecution();
  if (!claimed) return 'idle';
  try {
    const cases = await o.testCases.casesForWorkItem(claimed.workItem);
    const listed = cases.map((c) => ({ id: c.id, name: c.name, steps: c.steps }));
    if ((await o.testCases.getWorkItemExecution(claimed.id)).results?.length === 0) {
      await o.testCases.seedQueuedCaseProgress(claimed.id, claimed.workItem);
    }
    const url = await o.resolveUrl(claimed.environmentId);
    const ran = await o.run({
      run: claimed,
      cases: listed,
      url,
      onProgress: async (results) => {
        await o.testCases.reportWorkItemProgress(claimed.id, results);
      },
    });
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
      results: cases.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Blocked' as const, message })),
    });
  }
  return 'busy';
}
