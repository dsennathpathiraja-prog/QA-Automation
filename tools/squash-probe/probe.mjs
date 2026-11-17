#!/usr/bin/env node
// Read-only discovery probe for SquashTM. Zero dependencies (Node 18+).
// Sends GET requests only and reports status codes, versions and field NAMES,
// never field values, so the output is safe to paste into the project.
//
//   SQUASH_BASE_URL=http://squash.trafforge.local/squash \
//   SQUASH_TOKEN_FILE=./squash-token.txt \   (optional; without it only unauthenticated probes run)
//   node probe.mjs > squash-report.json

import { readFileSync } from 'node:fs';

const base = (process.env.SQUASH_BASE_URL ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Set SQUASH_BASE_URL, for example http://squash.trafforge.local/squash');
  process.exit(2);
}
const token = process.env.SQUASH_TOKEN_FILE ? readFileSync(process.env.SQUASH_TOKEN_FILE, 'utf8').trim() : undefined;
const timeoutMs = 15_000;
const api = `${base}/api/rest/latest`;

async function get(url, withToken) {
  const headers = { accept: 'application/json' };
  if (withToken && token) headers.authorization = `Bearer ${token}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ms: Date.now() - started, contentType: res.headers.get('content-type') ?? '', wwwAuthenticate: res.headers.get('www-authenticate') ?? undefined, location: res.headers.get('location') ?? undefined, json, bytes: text.length };
  } catch (e) {
    return { error: e?.cause?.code ?? e?.name ?? 'error' };
  }
}

const shape = (v, depth = 0) => {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    if (depth >= 3) return '{...}';
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k], depth + 1)]));
  }
  return v === null ? 'null' : typeof v;
};

const summarize = (r) => (r.error ? { error: r.error } : { status: r.status, ms: r.ms, contentType: r.contentType, wwwAuthenticate: r.wwwAuthenticate, redirectsTo: r.location ? new URL(r.location, base).pathname : undefined });

const report = { generatedAt: new Date().toISOString(), baseUrl: base, tokenSupplied: !!token, probes: {} };

report.probes.homePage = summarize(await get(`${base}/`, false));
report.probes.apiDocs = summarize(await get(`${api}/docs/api-documentation.html`, false));
report.probes.unauthenticatedProjects = summarize(await get(`${api}/projects?size=1`, false));

if (token) {
  const targets = {
    projects: '/projects?size=1',
    testCases: '/test-cases?size=1',
    requirements: '/requirements?size=1',
    campaigns: '/campaigns?size=1',
    iterations: '/iterations?size=1',
    executions: '/executions?size=1',
    users: '/users?size=1',
    customFields: '/custom-fields?size=1',
  };
  for (const [name, path] of Object.entries(targets)) {
    const r = await get(api + path, true);
    report.probes[name] = { ...summarize(r), page: r.json?.page, responseShape: r.json ? shape(r.json) : undefined };
  }
  const first = await get(`${api}/projects?size=1`, true);
  const id = first.json?._embedded?.projects?.[0]?.id;
  if (id !== undefined) {
    const t = await get(`${api}/projects/${id}/test-cases?size=1`, true);
    report.probes.projectTestCases = { ...summarize(t), page: t.json?.page, responseShape: t.json ? shape(t.json) : undefined };
  }
}

const unauthOk = report.probes.unauthenticatedProjects;
report.interpretation = {
  restApiPresent: unauthOk.status === 401 || unauthOk.status === 403 || unauthOk.status === 200 ? 'yes (the endpoint answers; 401 means authentication is required)' : unauthOk.status === 404 ? 'no or different context path (404)' : 'unknown',
  note: 'No data values are included. Only status codes, headers that describe authentication, and field names.',
};
console.log(JSON.stringify(report, null, 2));
