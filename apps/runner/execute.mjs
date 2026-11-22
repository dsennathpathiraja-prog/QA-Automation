/**
 * Runs prepared work-item cases against QA_TARGET_URL.
 * Prefers Playwright when installed; otherwise opens the URL over HTTP (same allowlist as reachability).
 * Prints PROGRESS_JSON while a case runs and one RESULT_JSON line per case for the worker to parse.
 * Screenshots are compact JPEG viewports; never emit the historic 1×1 red stub as evidence.
 */
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';

const timeoutMs = 15_000;
const target = process.env.QA_TARGET_URL ?? '';
const allowed = (process.env.QA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';
/** Keep RESULT_JSON lines well under Docker/HTTP limits. */
const MAX_SCREENSHOT_B64 = 120_000;

const finish = (code) => process.exit(code);

const hostAllowed = (hostname, port) => {
  const host = hostname.toLowerCase();
  const withPort = port ? `${host}:${port}` : host;
  return allowed.some((rule) => {
    if (rule.startsWith('*.')) return host === rule.slice(2) || host.endsWith(rule.slice(1));
    return rule === host || rule === withPort;
  });
};

let cases = [];
try {
  cases = JSON.parse(process.env.QA_CASES_JSON ?? '[]');
  if (!Array.isArray(cases)) cases = [];
} catch {
  cases = [];
}

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

function emitResult(row) {
  const shot = typeof row.screenshotPng === 'string' && row.screenshotPng.length >= 200
    ? shrinkScreenshot(row.screenshotPng)
    : undefined;
  const payload = { ...row };
  if (shot) payload.screenshotPng = shot;
  else delete payload.screenshotPng;
  console.log(`RESULT_JSON ${JSON.stringify(payload)}`);
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
  } catch {
    return undefined;
  }
}

/** Capture a viewport JPEG, retrying at lower quality / crop so we stay under the log size cap. */
async function captureViewport(page) {
  for (const quality of [40, 28, 18, 12]) {
    const buf = await page.screenshot({ type: 'jpeg', quality, fullPage: false });
    const b64 = buf.toString('base64');
    if (b64.length <= MAX_SCREENSHOT_B64) return b64;
  }
  const clipped = await page.screenshot({
    type: 'jpeg',
    quality: 12,
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
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    emitProgress(item, 'Running', 'Opening page', stepsAt(names, 0));
    const res = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    emitProgress(item, 'Running', 'Capturing screenshot', stepsAt(names, Math.min(1, names.length - 1), 'Passed', 'Running', 'Queued'));
    const screenshotPng = await captureViewport(page).catch(() => undefined);
    const statusCode = res?.status() ?? 0;
    const doneSteps = (fill) => names.map((name) => ({ name, status: fill }));
    const base = { testCaseId: item.id, name: item.name, ...(screenshotPng ? { screenshotPng } : {}), steps: doneSteps(!res ? 'Blocked' : statusCode >= 500 || statusCode < 200 ? 'Failed' : 'Passed') };
    if (!res) return { ...base, status: 'Blocked', message: 'did not answer', steps: doneSteps('Blocked') };
    if (statusCode >= 500) return { ...base, status: 'Failed', message: `answered ${statusCode}`, steps: doneSteps('Failed') };
    if (statusCode >= 200) return { ...base, status: 'Passed', message: `answered ${statusCode}`, steps: doneSteps('Passed') };
    return { ...base, status: 'Failed', message: `answered ${statusCode}`, steps: doneSteps('Failed') };
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
    if (status >= 500) return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${status}`, steps: done('Failed') };
    if (status >= 200) return { testCaseId: item.id, name: item.name, status: 'Passed', message: `answered ${status}`, steps: done('Passed') };
    return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${status}`, steps: done('Failed') };
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
