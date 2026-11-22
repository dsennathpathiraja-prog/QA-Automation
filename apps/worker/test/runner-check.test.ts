import { describe, expect, it } from 'vitest';
import { FakeRunnerLauncher } from '@qa/testing';
import { launcherDown, runReachabilityCheck } from '../src/runner-check';
import { PlatformError } from '@qa/domain';

const image = `qa-runner@sha256:${'a'.repeat(64)}`;
const environmentId = '11111111-1111-4111-8111-111111111111';

describe('reachability through a runner', () => {
  it('waits for the runner and reads the status it printed', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launcher.finish(handle.id, 0);
      return handle;
    };
    const result = await runReachabilityCheck({
      launcher,
      image,
      environmentId,
      url: 'https://qa.shop.example/shop',
      logs: async () => 'answered 200\n',
      now: 1,
    });
    expect(result).toEqual({ status: 200, viaRunner: true });
    const spec = launcher.specOf('runner-1');
    expect(spec.allowedHosts).toEqual(['qa.shop.example']);
    expect(spec.env).toEqual({ QA_TARGET_URL: 'https://qa.shop.example/shop' });
    expect(spec.image).toBe(image);
  });

  it('records a runner that could not reach the application', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launcher.finish(handle.id, 1);
      return handle;
    };
    await expect(runReachabilityCheck({ launcher, image, environmentId, url: 'https://qa.shop.example', logs: async () => 'did not answer\n', now: 2 })).rejects.toThrow(/did not answer/);
  });

  it('treats a missing launcher as a reason to check from the worker', () => {
    expect(launcherDown(new PlatformError('transient', 'could not resolve runner-launcher'))).toBe(true);
    expect(launcherDown(new PlatformError('transient', 'The runner image qa-runner:local is not on this machine yet. In PowerShell from the repo root:\ndocker compose -f deploy/compose/local/docker-compose.local.yml up --build -d\nThen re-run.'))).toBe(false);
    expect(launcherDown(new PlatformError('auth', 'the runner launcher rejected our credentials'))).toBe(false);
  });
});
