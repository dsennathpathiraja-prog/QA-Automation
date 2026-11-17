import type { DeploymentProfile } from '@qa/domain';
import { EgressPolicy, initTelemetry, readSecretFile } from '@qa/infrastructure';
import { connectPostgres, pingDb } from '@qa/persistence';
import { buildWorkerApp } from './app';
import { WorkerLoop } from './loop';

const env = process.env;
const profile = (env.PLATFORM_PROFILE ?? 'standard') as DeploymentProfile;
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }));

const telemetry = initTelemetry({
  serviceName: 'qa-worker',
  profile,
  egress: env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new EgressPolicy({ rules: [{ hostPattern: new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT).hostname, purpose: 'telemetry', internal: true, allowHttp: env.OTEL_EXPORTER_OTLP_ENDPOINT.startsWith('http://') }], profile, platformEnv: (env.PLATFORM_ENV ?? 'development') as 'development' | 'test' | 'production' })
    : undefined,
});

const password = env.DATABASE_PASSWORD_FILE ? readSecretFile(env.DATABASE_PASSWORD_FILE) : env.DATABASE_PASSWORD;
const conn =
  env.DATABASE_URL || env.DATABASE_HOST
    ? connectPostgres({ url: env.DATABASE_URL, host: env.DATABASE_HOST, port: env.DATABASE_PORT ? Number(env.DATABASE_PORT) : undefined, database: env.DATABASE_NAME, user: env.DATABASE_USER, password })
    : undefined;

// The workflow engine (Phase 3) replaces this tick. Until then the worker proves it can run,
// report health and stop cleanly, and it claims no work.
const loop = new WorkerLoop({
  tick: async () => 'idle',
  idleDelayMs: Number(env.WORKER_IDLE_MS ?? 1_000),
  graceMs: Number(env.WORKER_GRACE_MS ?? 30_000),
  onError: (e) => log('tick failed', { error: e instanceof Error ? e.message : 'unknown' }),
});

const app = buildWorkerApp({ loop, profile, readiness: conn ? { database: () => pingDb(conn.db) } : undefined });

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await loop.stop();
  await app.close();
  await conn?.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loop.start();
await app.listen({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3001) });
log('worker started', { profile, database: conn ? 'configured' : 'none' });
