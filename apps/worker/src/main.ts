import { buildProviders, buildSecretStore, connectDatabase } from '@qa/bootstrap';
import { PlatformError, type DeploymentProfile, type PlatformEnv } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, RemoteRunnerLauncher, initTelemetry, readSecretFile, type EgressRule } from '@qa/infrastructure';
import { tick as engineTick } from '@qa/workflow-engine';
import { PgApprovedHostRepository, PgAuditLog, PgAuditSink, PgConnectorRepository, PgEnvironmentRepository, PgExecutionRepository, PgTestRequestQueue, pingDb } from '@qa/persistence';
import { buildWorkerApp } from './app';
import { ConnectorTester } from './connector-tester';
import { ConnectorHealthScheduler } from './health-scheduler';
import { WorkerLoop } from './loop';
import { checkReachability } from './reachability';
import { launcherDown, runReachabilityCheck } from './runner-check';

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

const hosts = conn ? new PgApprovedHostRepository(conn.db) : undefined;
let tester: ConnectorTester | undefined;
let scheduler: ConnectorHealthScheduler | undefined;
if (conn && secrets && hosts) {
  const { providers, capabilities } = buildProviders(env, platformEnv);
  tester = new ConnectorTester({
    connectors: new PgConnectorRepository(conn.db),
    tests: new PgTestRequestQueue(conn.db),
    secrets: secrets.store,
    providers,
    capabilities,
    audit: new PgAuditSink(new PgAuditLog(conn.db)),
    http: async () => {
      const rules: EgressRule[] = (await hosts.list('connector')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'connector', internal: h.internal, allowHttp: h.allowHttp }));
      return new HardenedHttpClient({
        egress: new EgressPolicy({ rules, profile, platformEnv }),
        allowedMethods: ['GET', 'HEAD'],
        // Work-item search on Azure Boards and the managed Playwright server are the only POSTs a connector may send.
        allowOther: (req) => req.method === 'POST' && /\/(_apis\/wit\/wiql|mcp)$/.test(new URL(req.url).pathname),
        timeoutMs: 20_000,
        maxBodyBytes: 8 * 1024 * 1024,
      });
    },
  });
  scheduler = new ConnectorHealthScheduler({ connectors: new PgConnectorRepository(conn.db), tests: new PgTestRequestQueue(conn.db), intervalMs: env.CONNECTOR_HEALTH_MS ? Number(env.CONNECTOR_HEALTH_MS) : undefined });
}

const executions = conn ? new PgExecutionRepository(conn.db) : undefined;
const environments = conn ? new PgEnvironmentRepository(conn.db) : undefined;
const loop = new WorkerLoop({
  tick: async () => {
    let busy = false;
    if (tester) {
      await scheduler?.enqueueDue();
      if ((await tester.runOnce()) === 'busy') busy = true;
    }
    if (executions && (await engineTick(executions, { owner: 'worker', now: new Date() })) === 'busy') busy = true;
    if (environments && hosts && (await checkReachability(environments, async (target) => {
      const direct = async () => {
        const rules: EgressRule[] = (await hosts.list('application')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'application', internal: h.internal, allowHttp: h.allowHttp }));
        const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile, platformEnv }), allowedMethods: ['GET', 'HEAD'], timeoutMs: 10_000, maxBodyBytes: 64 * 1024 });
        const res = await http.request({ method: 'GET', url: target.applicationUrl, headers: { accept: '*/*' } });
        return { status: res.status };
      };
      const launcherUrl = env.RUNNER_LAUNCHER_URL;
      const launcherToken = env.RUNNER_LAUNCHER_TOKEN_FILE ? readSecretFile(env.RUNNER_LAUNCHER_TOKEN_FILE) : env.RUNNER_LAUNCHER_TOKEN;
      if (!launcherUrl || !launcherToken) return direct();
      try {
        const launcherHost = new URL(launcherUrl);
        const http = new HardenedHttpClient({
          egress: new EgressPolicy({
            rules: [{ hostPattern: launcherHost.hostname, purpose: 'platform', internal: true, allowHttp: launcherHost.protocol === 'http:', allowLoopback: launcherHost.hostname === 'localhost' || launcherHost.hostname === '127.0.0.1' }],
            profile,
            platformEnv,
          }),
          allowedMethods: ['GET', 'POST'],
          timeoutMs: 15_000,
        });
        const launcher = new RemoteRunnerLauncher({ baseUrl: launcherUrl, token: () => launcherToken, http });
        const image = await launcher.image();
        return await runReachabilityCheck({ launcher, image, environmentId: target.id, url: target.applicationUrl, logs: (id) => launcher.logs(id) });
      } catch (e) {
        if (launcherDown(e)) return direct();
        if (e instanceof PlatformError) throw e;
        throw new PlatformError('internal', 'The runner could not be started.');
      }
    })) === 'busy') busy = true;
    return busy ? 'busy' : 'idle';
  },
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
