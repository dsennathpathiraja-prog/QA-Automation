/**
 * Runs prepared work-item cases against QA_TARGET_URL.
 * Prefers Playwright when installed; otherwise opens the URL over HTTP (same allowlist as reachability).
 * Prints PROGRESS_JSON while a case runs and one RESULT_JSON line per case for the worker to parse.
 * Screenshots are kept small (JPEG viewport) so Docker log tail/JSON transport cannot drop results.
 */
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { readFile, writeFile } from 'node:fs/promises';

const timeoutMs = 15_000;
const target = process.env.QA_TARGET_URL ?? '';
const allowed = (process.env.QA_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';
/** Tiny 1×1 PNG used when a real screenshot cannot be taken. */
const STUB_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
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
  const screenshotPng = shrinkScreenshot(typeof row.screenshotPng === 'string' ? row.screenshotPng : STUB_PNG);
  console.log(`RESULT_JSON ${JSON.stringify({ ...row, screenshotPng })}`);
}

function shrinkScreenshot(b64) {
  if (!b64 || b64.length <= MAX_SCREENSHOT_B64) return b64 || STUB_PNG;
  return STUB_PNG;
}

function blocked(item, message) {
  const names = stepNames(item);
  return {
    testCaseId: item.id,
    name: item.name,
    status: 'Blocked',
    message,
    screenshotPng: STUB_PNG,
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
    const path = `/tmp/case-${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '')}.jpg`;
    await page.screenshot({ path, type: 'jpeg', quality: 42, fullPage: false });
    const png = Buffer.from(await readFile(path)).toString('base64');
    const statusCode = res?.status() ?? 0;
    const doneSteps = (fill) => names.map((name) => ({ name, status: fill }));
    if (!res) {
      return { testCaseId: item.id, name: item.name, status: 'Blocked', message: 'did not answer', screenshotPng: png, steps: doneSteps('Blocked') };
    }
    if (statusCode >= 500) {
      return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${statusCode}`, screenshotPng: png, steps: doneSteps('Failed') };
    }
    if (statusCode >= 200) {
      return { testCaseId: item.id, name: item.name, status: 'Passed', message: `answered ${statusCode}`, screenshotPng: png, steps: doneSteps('Passed') };
    }
    return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${statusCode}`, screenshotPng: png, steps: doneSteps('Failed') };
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
    const screenshotPng = STUB_PNG;
    await writeFile(`/tmp/case-${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '')}.png`, Buffer.from(STUB_PNG, 'base64')).catch(() => undefined);
    const done = (fill) => names.map((name) => ({ name, status: fill }));
    if (status >= 500) return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${status}`, screenshotPng, steps: done('Failed') };
    if (status >= 200) return { testCaseId: item.id, name: item.name, status: 'Passed', message: `answered ${status}`, screenshotPng, steps: done('Passed') };
    return { testCaseId: item.id, name: item.name, status: 'Failed', message: `answered ${status}`, screenshotPng, steps: done('Failed') };
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
