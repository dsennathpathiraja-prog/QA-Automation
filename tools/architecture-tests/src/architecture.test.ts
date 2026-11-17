import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_WORKSPACE_DEPS, BROWSER_PACKAGES, IO_PACKAGES, NO_FS_PACKAGES, NO_SECRET_READ_PACKAGES, analyzeSource, isFs, isGitWrite, isNetwork, type Finding,
} from './analyzer';

const root = resolve(__dirname, '../../..');

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listTs(p) : p.endsWith('.ts') ? [p] : [];
  });
}

interface Pkg {
  name: string;
  dir: string;
  deps: string[];
}

function workspacePackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const group of ['packages', 'apps']) {
    const g = join(root, group);
    if (!existsSync(g)) continue;
    for (const n of readdirSync(g)) {
      const pj = join(g, n, 'package.json');
      if (!existsSync(pj)) continue;
      const j = JSON.parse(readFileSync(pj, 'utf8')) as { dependencies?: Record<string, string> };
      out.push({
        name: n,
        dir: join(g, n),
        deps: Object.keys(j.dependencies ?? {}).filter((d) => d.startsWith('@qa/')).map((d) => d.slice(4)),
      });
    }
  }
  return out;
}

const pkgs = workspacePackages();

/** The one file per deployable that wires concrete infrastructure into the application. */
const COMPOSITION_ROOTS: Record<string, string> = { api: 'apps/api/src/server.ts', worker: 'apps/worker/src/main.ts', 'runner-launcher': 'apps/runner-launcher/src/main.ts' };

/** Rule evaluation shared by the real scan and the self-tests. */
export function violationsFor(pkg: string, file: string, findings: Finding[]): string[] {
  const v: string[] = [];
  const allowed = ALLOWED_WORKSPACE_DEPS[pkg] ?? [];
  for (const f of findings) {
    const where = `${pkg}: ${file}:${f.line}`;
    if (f.kind === 'fetch-call' && !IO_PACKAGES.has(pkg) && !BROWSER_PACKAGES.has(pkg)) v.push(`${where} calls global fetch (network access is infrastructure-only)`);
    if (f.kind === 'secret-lease' && NO_SECRET_READ_PACKAGES.has(pkg)) v.push(`${where} calls .lease() (only the worker side may read secret values; ${pkg} must not)`);
    if (f.kind !== 'import') continue;
    const s = f.specifier;
    if (isGitWrite(s)) v.push(`${where} imports ${s} (no git/hosting write libraries anywhere)`);
    if (isNetwork(s) && !IO_PACKAGES.has(pkg)) v.push(`${where} imports ${s} (network/process access is infrastructure-only)`);
    if (isFs(s) && NO_FS_PACKAGES.has(pkg)) v.push(`${where} imports ${s} (filesystem access not allowed in this layer)`);
    if (s.startsWith('@qa/')) {
      const target = s.slice(4).split('/')[0]!;
      const root = COMPOSITION_ROOTS[pkg];
      if (root && (target === 'infrastructure' || target === 'persistence') && !file.endsWith(root)) {
        v.push(`${where} imports @qa/${target} outside the composition root (only ${root} may)`);
      }
      if (target !== pkg && !allowed.includes('*') && !allowed.includes(target)) v.push(`${where} imports @qa/${target} which ${pkg} may not depend on`);
    }
  }
  return v;
}

describe('architecture rules (layer boundaries)', () => {
  it('every workspace package declares its allowed dependencies', () => {
    for (const p of pkgs) expect(Object.keys(ALLOWED_WORKSPACE_DEPS), `unknown package ${p.name}`).toContain(p.name);
  });

  it('package.json dependencies respect the allowlist', () => {
    const bad: string[] = [];
    for (const p of pkgs) {
      const allowed = ALLOWED_WORKSPACE_DEPS[p.name] ?? [];
      for (const d of p.deps) if (!allowed.includes('*') && !allowed.includes(d)) bad.push(`${p.name} -> ${d}`);
    }
    expect(bad).toEqual([]);
  });

  it('source files respect import and IO rules', () => {
    const all: string[] = [];
    for (const p of pkgs) {
      for (const f of listTs(join(p.dir, 'src'))) {
        all.push(...violationsFor(p.name, relative(root, f), analyzeSource(f, readFileSync(f, 'utf8'))));
      }
    }
    expect(all).toEqual([]);
  });

  it('no package anywhere depends on a git or hosting write library', () => {
    const bad: string[] = [];
    for (const dir of ['packages', 'apps']) {
      for (const n of existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : []) {
        const pj = join(root, dir, n, 'package.json');
        if (!existsSync(pj)) continue;
        const j = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, Record<string, string> | undefined>;
        for (const d of Object.keys({ ...j.dependencies, ...j.devDependencies })) if (isGitWrite(d)) bad.push(`${n}: ${d}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('architecture rules detect violations (self-test)', () => {
  const check = (pkg: string, src: string) => violationsFor(pkg, 'x.ts', analyzeSource('x.ts', src));

  it('flags network and fetch in agents and workflow-engine', () => {
    expect(check('agents', `import http from 'node:http';`)).toHaveLength(1);
    expect(check('agents', `await fetch('https://api.github.com')`)).toHaveLength(1);
    expect(check('workflow-engine', `import axios from 'axios'`)).toHaveLength(1);
    expect(check('agents', `const m = await import('undici')`)).toHaveLength(1);
    expect(check('agents', `const c = require('child_process')`)).toHaveLength(1);
  });

  it('flags agents importing connectors or infrastructure', () => {
    expect(check('agents', `import { x } from '@qa/infrastructure'`)).toHaveLength(1);
    expect(check('agents', `import { x } from '@qa/connector-github'`)).toHaveLength(1);
    expect(check('agents', `import { x } from '@qa/connector-sdk'`)).toHaveLength(0);
  });

  it('keeps the SPA on contracts only: it may call fetch but never import domain, security, persistence or Node modules', () => {
    expect(check('web', `await fetch('/api/v1/me')`)).toHaveLength(0);
    expect(check('web', `import { ROLE_PERMISSIONS } from '@qa/domain'`)).toHaveLength(1);
    expect(check('web', `import { x } from '@qa/security'`)).toHaveLength(1);
    expect(check('web', `import { x } from '@qa/persistence'`)).toHaveLength(1);
    expect(check('web', `import fs from 'node:fs'`)).toHaveLength(1);
    expect(check('web', `import http from 'node:http'`)).toHaveLength(1);
    expect(check('web', `import { z } from '@qa/contracts'`)).toHaveLength(0);
  });

  it('keeps the model layer provider-neutral: agents may use the llm port, llm may not touch IO, infrastructure or connectors', () => {
    expect(check('agents', `import type { LlmPort } from '@qa/llm'`)).toHaveLength(0);
    expect(check('llm', `import { OllamaAdapter } from '@qa/infrastructure'`)).toHaveLength(1);
    expect(check('llm', `import { x } from '@qa/connector-sdk'`)).toHaveLength(1);
    expect(check('llm', `await fetch('http://ollama:11434')`)).toHaveLength(1);
    expect(check('llm', `import { request } from 'undici'`)).toHaveLength(1);
    expect(check('llm', `import { readFileSync } from 'node:fs'`)).toHaveLength(1);
    expect(check('llm', `import { createHash } from 'node:crypto'`)).toHaveLength(0);
    expect(check('web', `import { x } from '@qa/llm'`)).toHaveLength(1);
  });

  it('lets only the api composition root import infrastructure', () => {
    const v = (file: string) => violationsFor('api', file, analyzeSource(file, `import { x } from '@qa/infrastructure'`));
    expect(v('apps/api/src/server.ts')).toHaveLength(0);
    expect(v('apps/api/src/app.ts')).toHaveLength(1);
  });

  it('lets only the worker composition root import infrastructure and persistence', () => {
    const v = (file: string, target: string) => violationsFor('worker', file, analyzeSource(file, `import { x } from '@qa/${target}'`));
    expect(v('apps/worker/src/main.ts', 'infrastructure')).toHaveLength(0);
    expect(v('apps/worker/src/main.ts', 'persistence')).toHaveLength(0);
    expect(v('apps/worker/src/loop.ts', 'persistence')).toHaveLength(1);
    expect(v('apps/worker/src/app.ts', 'infrastructure')).toHaveLength(1);
    expect(v('apps/worker/src/loop.ts', 'domain')).toHaveLength(0);
  });

  it('keeps secret values out of the api, the web app and every layer above the worker', () => {
    const lease = `await store.lease('connectors/c1/token')`;
    for (const pkg of ['api', 'web', 'agents', 'application', 'llm']) expect(check(pkg, lease), pkg).toHaveLength(1);
    for (const pkg of ['connector-sdk', 'infrastructure', 'testing', 'worker']) expect(check(pkg, lease), pkg).toHaveLength(0);
    expect(NO_SECRET_READ_PACKAGES.has('api')).toBe(true);
  });

  it('flags filesystem use in domain and connector-sdk, and any git write library', () => {
    expect(check('domain', `import fs from 'node:fs'`)).toHaveLength(1);
    expect(check('connector-sdk', `import { readFile } from 'fs/promises'`)).toHaveLength(1);
    expect(check('infrastructure', `import git from 'simple-git'`)).toHaveLength(1);
    expect(check('infrastructure', `import { Octokit } from '@octokit/rest'`)).toHaveLength(1);
  });

  it('allows infrastructure to do IO and the SPA-facing layers to stay clean', () => {
    expect(check('infrastructure', `import { lookup } from 'node:dns/promises'; import { Agent } from 'undici'; fetch('x')`)).toHaveLength(0);
    expect(check('domain', `import { x } from '@qa/security'`)).toHaveLength(1);
  });
});
