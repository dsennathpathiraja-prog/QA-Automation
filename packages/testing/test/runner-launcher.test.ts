import { describe, expect, it } from 'vitest';
import { validateRunnerSpec, type RunnerSpec } from '@qa/domain';
import { FakeRunnerLauncher } from '../src';

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
});

describe('FakeRunnerLauncher (the contract real adapters must meet)', () => {
  it('validates before launching and does not start anything for an invalid spec', async () => {
    const l = new FakeRunnerLauncher();
    await expect(l.launch(spec({ image: 'playwright:latest' }))).rejects.toMatchObject({ errorClass: 'validation' });
    expect(l.launches).toBe(0);
  });

  it('is idempotent on runId', async () => {
    const l = new FakeRunnerLauncher();
    const a = await l.launch(spec());
    const b = await l.launch(spec());
    expect(b.id).toBe(a.id);
    expect(l.launches).toBe(1);
  });

  it('reports status, stop with reason, and natural exit codes', async () => {
    const l = new FakeRunnerLauncher();
    const a = await l.launch(spec({ runId: 'r-a' }));
    const b = await l.launch(spec({ runId: 'r-b' }));
    expect((await l.status(a.id)).state).toBe('running');
    await l.stop(a.id, 'user cancelled');
    expect(await l.status(a.id)).toMatchObject({ state: 'stopped', reason: 'user cancelled' });
    l.finish(b.id, 1);
    expect(await l.status(b.id)).toMatchObject({ state: 'failed', exitCode: 1 });
    await l.stop(b.id, 'late');
    expect((await l.status(b.id)).state).toBe('failed');
    await expect(l.status('nope')).rejects.toMatchObject({ errorClass: 'not-found' });
  });

  it('lists runners by label for the reaper', async () => {
    const l = new FakeRunnerLauncher();
    await l.launch(spec({ runId: 'r1', labels: { execution: 'ex-1' } }));
    await l.launch(spec({ runId: 'r2', labels: { execution: 'ex-2' } }));
    expect((await l.list({ execution: 'ex-2' })).map((r) => r.runId)).toEqual(['r2']);
  });
});
