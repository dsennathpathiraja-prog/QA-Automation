import { PlatformError, type RunnerLauncher, type RunnerSpec } from '@qa/domain';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The launcher host did not answer, so the caller can use the worker's own check. */
export function launcherDown(e: unknown): boolean {
  return e instanceof PlatformError && e.errorClass === 'transient' && /could not resolve|network error|timed out|not reachable/.test(e.message);
}

/**
 * Places one reachability check in a runner and waits for it to finish.
 * The image must already be the digest pin the launcher advertised.
 */
export async function runReachabilityCheck(o: {
  launcher: RunnerLauncher;
  image: string;
  environmentId: string;
  url: string;
  logs(runnerId: string): Promise<string>;
  now?: number;
}): Promise<{ status: number; viaRunner: true }> {
  const target = new URL(o.url);
  const host = target.hostname.toLowerCase();
  const spec: RunnerSpec = {
    runId: `reach-${o.environmentId.replace(/[^A-Za-z0-9]/g, '')}-${o.now ?? Date.now()}`,
    executionId: o.environmentId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || 'environment',
    image: o.image,
    bundleRef: 'reachability',
    environmentId: o.environmentId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || 'environment',
    limits: { cpus: 0.5, memoryMb: 512, timeoutSeconds: 20, pids: 64 },
    allowedHosts: [target.port ? `${host}:${target.port}` : host],
    env: { QA_TARGET_URL: o.url },
  };
  const handle = await o.launcher.launch(spec);
  const deadline = Date.now() + (spec.limits.timeoutSeconds + 5) * 1000;
  let state = await o.launcher.status(handle.id);
  while (state.state === 'starting' || state.state === 'running') {
    if (Date.now() > deadline) {
      await o.launcher.stop(handle.id, 'the reachability check took too long');
      throw new PlatformError('internal', 'The runner did not finish in time.');
    }
    await sleep(250);
    state = await o.launcher.status(handle.id);
  }
  const text = await o.logs(handle.id);
  const status = Number(/answered (\d+)/.exec(text)?.[1]);
  if (Number.isInteger(status) && status > 0) return { status, viaRunner: true };
  if (text.includes('host not allowed')) throw new PlatformError('internal', 'The runner refused the application host.');
  if (state.state === 'exited' && state.exitCode === 0) return { status: 200, viaRunner: true };
  throw new PlatformError('internal', 'The runner finished. The application did not answer.');
}
