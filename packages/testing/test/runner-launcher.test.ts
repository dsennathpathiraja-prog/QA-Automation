import { describe, expect, it } from 'vitest';
import { validateRunnerSpec, type RunnerSpec } from '@qa/domain';
import { FakeRunnerLauncher, runnerLauncherContract } from '../src';

const digest = 'a'.repeat(64);
const spec = (over: Partial<RunnerSpec> = {}): RunnerSpec => ({
  runId: 'run-1',
  executionId: 'ex-1',
  image: `registry.local/qa/playwright@sha256:${digest}`,
  bundleRef: 'bundles/ex-1.tar.sig',
  environmentId: 'env-staging',
  limits: { cpus: 2, memoryMb: 2048, timeoutSeconds: 1800, pids: 512 },
  allowedHosts: ['shop.staging.example.com'],
  ...over,
});

describe('runner spec validation', () => {
  it('accepts a complete, digest-pinned spec', () => {
    expect(validateRunnerSpec(spec())).toEqual([]);
  });

  it('refuses images that are not pinned by digest', () => {
    for (const image of ['mcr.microsoft.com/playwright:latest', 'playwright', `playwright@sha256:${'a'.repeat(63)}`]) {
      expect(validateRunnerSpec(spec({ image })).join()).toMatch(/pinned by digest/);
    }
  });

  it('requires limits inside the platform maximums', () => {
    const p = validateRunnerSpec(spec({ limits: { cpus: 64, memoryMb: 64, timeoutSeconds: 0, pids: 100_000 } })).join(' ');
    expect(p).toMatch(/limits.cpus/);
    expect(p).toMatch(/limits.memoryMb/);
    expect(p).toMatch(/limits.timeoutSeconds/);
    expect(p).toMatch(/limits.pids/);
  });

  it('requires an explicit network allowlist and rejects wildcards and URLs', () => {
    expect(validateRunnerSpec(spec({ allowedHosts: [] })).join()).toMatch(/at least one host/);
    for (const h of ['*', 'https://shop.example.com', 'shop.example.com/path', '*shop.example.com']) {
      expect(validateRunnerSpec(spec({ allowedHosts: [h] })).join(), h).toMatch(/not a host name/);
    }
    expect(validateRunnerSpec(spec({ allowedHosts: ['*.staging.example.com', 'shop.example.com:8443'] }))).toEqual([]);
  });

  it('keeps secrets out of env and reserved labels out of labels', () => {
    const p = validateRunnerSpec(spec({ env: { APP_PASSWORD: 'x', BASE_URL: 'https://a' }, labels: { 'qa.platform/execution': 'spoof' } })).join(' ');
    expect(p).toMatch(/APP_PASSWORD looks like a secret/);
    expect(p).not.toMatch(/BASE_URL/);
    expect(p).toMatch(/reserved prefix/);
  });

  it('rejects ids that could break out of a name or path', () => {
    expect(validateRunnerSpec(spec({ runId: '../x' })).join()).toMatch(/runId/);
    expect(validateRunnerSpec(spec({ executionId: 'a b' })).join()).toMatch(/executionId/);
  });

  it('accepts /tmp inlineFiles for large case lists and rejects unsafe paths or oversize payloads', () => {
    expect(validateRunnerSpec(spec({ inlineFiles: [{ path: '/tmp/qa-cases.json', content: '[]' }] }))).toEqual([]);
    expect(validateRunnerSpec(spec({ inlineFiles: [{ path: '/etc/passwd', content: 'x' }] })).join()).toMatch(/\/tmp\//);
    expect(validateRunnerSpec(spec({ inlineFiles: [{ path: '/tmp/qa-cases.json', content: 'x'.repeat(2 * 1024 * 1024 + 1) }] })).join()).toMatch(/byte limit/);
  });

  it('still rejects oversized env values (cases must use inlineFiles)', () => {
    expect(validateRunnerSpec(spec({ env: { QA_CASES_JSON: 'x'.repeat(4097) } })).join()).toMatch(/QA_CASES_JSON is too long/);
  });
});

runnerLauncherContract('FakeRunnerLauncher', async () => {
  const launcher = new FakeRunnerLauncher();
  return { launcher, finish: (id, code) => launcher.finish(id, code) };
});
