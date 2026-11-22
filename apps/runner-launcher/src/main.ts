import { LABEL, enforceTimeouts } from '@qa/domain';
import { DockerEngine, readSecretFile } from '@qa/infrastructure';
import { buildLauncherApp } from './app';

const env = process.env;
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }));

const token = env.LAUNCHER_TOKEN_FILE ? readSecretFile(env.LAUNCHER_TOKEN_FILE) : env.LAUNCHER_TOKEN;
if (!token || token.length < 24) throw new Error('LAUNCHER_TOKEN_FILE (or LAUNCHER_TOKEN) with at least 24 characters is required');
const prefixes = (env.RUNNER_IMAGE_PREFIXES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (prefixes.length === 0) throw new Error('RUNNER_IMAGE_PREFIXES must list the approved registries, for example registry.local/qa/');

const engine = new DockerEngine({ socketPath: env.DOCKER_SOCKET ?? '/var/run/docker.sock' });
const app = buildLauncherApp({
  engine,
  token,
  allowedImagePrefixes: prefixes,
  maxConcurrent: (() => {
    const n = Number(env.RUNNER_MAX_CONCURRENT ?? 4);
    // Number("") === 0 would make the pool always "full" even with zero runners.
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
  })(),
  translate: { network: env.RUNNER_NETWORK ?? 'automation', proxyUrl: env.RUNNER_PROXY_URL },
  localImage: env.RUNNER_LOCAL_IMAGE ? { repository: env.RUNNER_IMAGE_REPOSITORY ?? 'qa-runner', ref: env.RUNNER_LOCAL_IMAGE } : undefined,
});

const sweep = setInterval(() => {
  enforceTimeouts(engine, new Date()).then(
    (stopped) => stopped.length > 0 && log('stopped runners over their time limit', { runIds: stopped }),
    (e) => log('timeout sweep failed', { error: e instanceof Error ? e.message : 'unknown' }),
  );
  // Drop exited / never-started managed runners so they cannot pin the concurrent pool.
  engine.list({ [LABEL.managed]: 'true' }).then(async (list) => {
    let removed = 0;
    for (const c of list) {
      if (c.status === 'running' || c.status === 'restarting' || c.status === 'paused' || c.status === 'removing') continue;
      try {
        await engine.remove(c.id);
        removed += 1;
      } catch {
        /* best-effort */
      }
    }
    if (removed > 0) log('reclaimed finished runners', { removed });
  }, (e) => log('reclaim sweep failed', { error: e instanceof Error ? e.message : 'unknown' }));
}, 30_000);

const shutdown = async () => {
  clearInterval(sweep);
  await app.close();
  await engine.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3002) });
log('runner launcher started');
