/**
 * Runs prepared work-item cases against QA_TARGET_URL.
 * Prefers Playwright when installed; otherwise opens the URL over HTTP (same allowlist as reachability).
 * Prints PROGRESS_JSON while a case runs and one RESULT_JSON line per case for the worker to parse.
 *
 * Screenshots are emitted on a separate SCREENSHOT_JSON line so RESULT_JSON stays small.
 * Docker log / launcher JSON responses often truncate multi‑100KB lines; putting status after a huge
 * base64 field used to drop both the parseable result and the image (worker then probe-fell-back
 * to “answered 200” with no evidence).
 */
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

const timeoutMs = 15_000;
const target = process.env.QA_TARGET_URL ?? '';
const allowed = (process.env.QA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';
/** Keep each log line well under common Docker/HTTP truncation thresholds (~16–64KiB). */
const MAX_SCREENSHOT_B64 = 48_000;

const finish = (code) => process.exit(code);

/**
 * Load cases from chunked env (QA_CASES_PARTS + QA_CASES_P0…).
 * Fallbacks: QA_CASES_FILE (legacy putFiles) then single QA_CASES_JSON.
 */
async function loadCases() {
  const parts = Number(process.env.QA_CASES_PARTS ?? '');
  if (Number.isInteger(parts) && parts >= 0 && process.env.QA_CASES_PARTS !== undefined && process.env.QA_CASES_PARTS !== '') {
    if (parts === 0) return [];
    let raw = '';
    for (let i = 0; i < parts; i += 1) {
      const piece = process.env[`QA_CASES_P${i}`];
      if (piece === undefined) {
        console.log(`cases chunk QA_CASES_P${i} missing`);
        return [];
      }
      raw += piece;
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.log(`cases chunks invalid JSON: ${e instanceof Error ? e.message : 'error'}`);
      return [];
    }
  }
  const file = process.env.QA_CASES_FILE;
  if (file) {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.log(`cases file unreadable: ${e instanceof Error ? e.message : 'error'}`);
      return [];
    }
  }
  try {
    const parsed = JSON.parse(process.env.QA_CASES_JSON ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const hostAllowed = (hostname, port) => {
  const host = hostname.toLowerCase();
  const withPort = port ? `${host}:${port}` : host;
  return allowed.some((rule) => {
    if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
    return rule === host || rule === withPort;
  });
};

let cases = await loadCases();

let url;
try {
  url = new URL(target);
} catch {
  for (const item of cases) emitResult(blocked(item, 'did not answer'));
  finish(1);
}

if (!hostAllowed(url.hostname, url.port)) {
  for (const item of cases) emitResult(blocked(item, 'host not allowed'));
  finish(1);
}

if (cases.length === 0) {
  console.log('no cases');
  finish(0);
}

const playwright = await loadPlaywright();
console.log(`RUNNER_MODE ${JSON.stringify({ capture: playwright ? 'playwright' : 'http', browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null })}`);

for (const item of cases) {
  try {
    const result = playwright
      ? await runWithPlaywright(playwright, url, item)
      : await runWithHttp(url, item);
    emitResult(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'did not answer';
    emitResult(blocked(item, message));
  }
}
finish(0);

function stepNames(item) {
  if (Array.isArray(item.steps) && item.steps.length > 0) {
    return item.steps.map((s) => (typeof s === 'string' ? s : String(s?.name ?? ''))).filter(Boolean).slice(0, 12);
  }
  return ['Open page', 'Capture evidence'];
}

function stepsAt(names, activeIndex, fillBefore = 'Passed', active = 'Running', fillAfter = 'Queued') {
  return names.map((name, i) => ({
    name,
    status: i < activeIndex ? fillBefore : i === activeIndex ? active : fillAfter,
  }));
}

function emitProgress(item, status, message, steps) {
  console.log(`PROGRESS_JSON ${JSON.stringify({ testCaseId: item.id, name: item.name, status, message, steps })}`);
}

/**
 * Status line first (always small), then optional screenshot line.
 * Never put base64 ahead of status/message in RESULT_JSON.
 */
function emitResult(row) {
  const shot = typeof row.screenshotPng === 'string' && row.screenshotPng.length >= 200
    ? shrinkScreenshot(row.screenshotPng)
    : undefined;
  const payload = {
    testCaseId: row.testCaseId,
    name: row.name,
    status: row.status,
    message: row.message,
    steps: row.steps,
  };
  console.log(`RESULT_JSON ${JSON.stringify(payload)}`);
  if (shot) {
    console.log(`SCREENSHOT_JSON ${JSON.stringify({ testCaseId: row.testCaseId, screenshotPng: shot })}`);
  }
}

/** Prefer a smaller JPEG over dropping evidence entirely. */
function shrinkScreenshot(b64) {
  if (!b64) return undefined;
  if (b64.length <= MAX_SCREENSHOT_B64) return b64;
  return undefined;
}

function blocked(item, message) {
  const names = stepNames(item);
  return {
    testCaseId: item.id,
    name: item.name,
    status: 'Blocked',
    message,
    steps: names.map((name) => ({ name, status: 'Blocked' })),
  };
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'import failed';
    console.log(`RUNNER_MODE ${JSON.stringify({ capture: 'http', reason })}`);
    return undefined;
  }
}

/** Capture a compact viewport JPEG under the log-line size cap. */
async function captureViewport(page) {
  for (const quality of [36, 24, 16, 10]) {
    const buf = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
    const b64 = buf.toString('base64');
    if (b64.length <= MAX_SCREENSHOT_B64) return b64;
  }
  const clipped = await page.screenshot({
    type: 'jpeg',
    quality: 10,
    fullPage: false,
    clip: { x: 0, y: 0, width: 640, height: 360 },
  });
  const b64 = clipped.toString('base64');
  return b64.length <= MAX_SCREENSHOT_B64 ? b64 : undefined;
}

async function runWithPlaywright(pw, u, item) {
  const names = stepNames(item);
  emitProgress(item, 'Running', 'Opening browser', stepsAt(names, 0));
  const browser = await pw.chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    emitProgress(item, 'Running', 'Opening page', stepsAt(names, 0));
    const res = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    emitProgress(item, 'Running', 'Capturing screenshot', stepsAt(names, Math.min(1, names.length - 1), 'Passed', 'Running', 'Queued'));
    let screenshotPng;
    let captureNote;
    try {
      screenshotPng = await captureViewport(page);
      if (!screenshotPng) captureNote = 'screenshot exceeded size cap';
    } catch (e) {
      captureNote = e instanceof Error ? e.message : 'screenshot failed';
      screenshotPng = undefined;
    }
    const statusCode = res?.status() ?? 0;
    const doneSteps = (fill) => names.map((name) => ({ name, status: fill }));
    const suffix = captureNote ? ` · no screenshot (${captureNote})` : '';
    if (!res) {
      return { testCaseId: item.id, name: item.name, status: 'Blocked', message: `did not answer${suffix}`, steps: doneSteps('Blocked'), ...(screenshotPng ? { screenshotPng } : {}) };
    }
    if (statusCode >= 500) {
      return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${statusCode}${suffix}`, steps: doneSteps('Failed'), ...(screenshotPng ? { screenshotPng } : {}) };
    }
    if (statusCode >= 200) {
      return { testCaseId: item.id, name: item.name, status: 'Passed', message: `answered ${statusCode}${suffix}`, steps: doneSteps('Passed'), ...(screenshotPng ? { screenshotPng } : {}) };
    }
    return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${statusCode}${suffix}`, steps: doneSteps('Failed'), ...(screenshotPng ? { screenshotPng } : {}) };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'did not answer';
    return blocked(item, message);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function runWithHttp(u, item) {
  const names = stepNames(item);
  emitProgress(item, 'Running', 'Opening page', stepsAt(names, 0));
  try {
    const status = proxy ? await throughProxy(u, proxy) : await direct(u);
    emitProgress(item, 'Running', 'Recording result', stepsAt(names, Math.min(1, names.length - 1), 'Passed', 'Running', 'Queued'));
    // HTTP probe cannot capture a page image — omit screenshot (UI shows empty state, not a red stub).
    const done = (fill) => names.map((name) => ({ name, status: fill }));
    const hint = ' · no screenshot (HTTP probe; Playwright unavailable in runner image)';
    if (status >= 500) return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${status}${hint}`, steps: done('Failed') };
    if (status >= 200) return { testCaseId: item.id, name: item.name, status: 'Passed', message: `answered ${status}${hint}`, steps: done('Passed') };
    return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${status}${hint}`, steps: done('Failed') };
  } catch {
    return blocked(item, 'did not answer');
  }
}

function direct(u) {
  return fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }).then((res) => res.status);
}

function throughProxy(u, proxyUrl) {
  const p = new URL(proxyUrl);
  if (u.protocol === 'http:') return plain(p, { method: 'GET', path: u.href, headers: { host: u.host, accept: '*/*' } });
  return new Promise((resolve, reject) => {
    const req = httpRequest({ protocol: p.protocol, hostname: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${u.hostname}:${u.port || 443}`, timeout: timeoutMs });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error('proxy refused'));
        return;
      }
      const tls = tlsConnect({ socket, servername: u.hostname });
      tls.once('secureConnect', () => {
        tls.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      });
      let raw = '';
      tls.on('data', (chunk) => { raw += chunk.toString('utf8'); });
      tls.once('error', reject);
      tls.once('end', () => {
        const code = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(raw)?.[1]);
        if (!code) reject(new Error('no status'));
        else resolve(code);
      });
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}

function plain(p, options) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ protocol: p.protocol, hostname: p.hostname, port: p.port || 80, timeout: timeoutMs, ...options }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}
