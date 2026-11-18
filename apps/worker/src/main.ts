import { buildProviders, buildSecretStore, connectDatabase } from '@qa/bootstrap';
import type { DeploymentProfile, PlatformEnv } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, initTelemetry, type EgressRule } from '@qa/infrastructure';
import { PgApprovedHostRepository, PgAuditLog, PgAuditSink, PgConnectorRepository, PgTestRequestQueue, pingDb } from '@qa/persistence';
import { buildWorkerApp } from './app';
import { ConnectorTester } from './connector-tester';
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

const platformEnv = (env.PLATFORM_ENV ?? 'development') as PlatformEnv;
const conn = connectDatabase(env);
const secrets = buildSecretStore(env, platformEnv, conn?.db);

let tester: ConnectorTester | undefined;
if (conn && secrets) {
  const { providers, capabilities } = buildProviders(env, platformEnv);
  const hosts = new PgApprovedHostRepository(conn.db);
  tester = new ConnectorTester({
    connectors: new PgConnectorRepository(conn.db),
    tests: new PgTestRequestQueue(conn.db),
    secrets: secrets.store,
    providers,
    capabilities,
    audit: new PgAuditSink(new PgAuditLog(conn.db)),
    http: async () => {
      const rules: EgressRule[] = (await hosts.list('connector')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'connector', internal: h.internal, allowHttp: h.allowHttp }));
      return new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile, platformEnv }), allowedMethods: ['GET', 'HEAD'], timeoutMs: 20_000, maxBodyBytes: 8 * 1024 * 1024 });
    },
  });
}

// The workflow engine (Phase 3) extends this tick. Until then the worker runs Test Connection requests
// for connectors, reports health and stops cleanly.
const loop = new WorkerLoop({
  tick: async () => (tester ? tester.runOnce() : 'idle'),
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
log('worker started', { profile, database: conn ? 'configured' : 'none', secretStore: secrets?.kind ?? 'none', connectorTests: tester ? 'enabled' : 'disabled' });
