import { buildProviders, buildSecretStore, connectDatabase } from '@qa/bootstrap';
import { ConnectorExecutionManager } from '@qa/connector-sdk';
import { PlatformError, type DeploymentProfile, type PlatformEnv } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, RemoteRunnerLauncher, initTelemetry, readSecretFile, type EgressRule } from '@qa/infrastructure';
import { SecretRedactor } from '@qa/security';
import { runFlowStep, tick as engineTick } from '@qa/workflow-engine';
import { TestCaseService } from '@qa/application';
import { PgApprovedHostRepository, PgAuditLog, PgAuditSink, PgConnectorRepository, PgEnvironmentRepository, PgExecutionRepository, PgInstanceResolver, PgOperationLogSink, PgRunPolicyStore, PgTestCaseRepository, PgTestRequestQueue, pingDb } from '@qa/persistence';
import { publishGeneratedCases, type GeneratedCase } from './publish-cases';
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
let squash: ConnectorExecutionManager | undefined;
const built = conn && secrets && hosts ? buildProviders(env, platformEnv) : undefined;
if (conn && secrets && hosts && built) {
  tester = new ConnectorTester({
    connectors: new PgConnectorRepository(conn.db),
    tests: new PgTestRequestQueue(conn.db),
    secrets: secrets.store,
    providers: built.providers,
    capabilities: built.capabilities,
    audit: new PgAuditSink(new PgAuditLog(conn.db)),
    http: async () => {
      const rules: EgressRule[] = (await hosts.list('connector')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'connector', internal: h.internal, allowHttp: h.allowHttp }));
      return new HardenedHttpClient({
        egress: new EgressPolicy({ rules, profile, platformEnv }),
        allowedMethods: ['GET', 'HEAD'],
        // Work-item search, the Playwright server, and storing a generated Squash test case are the only writes a connector may send.
        allowOther: (req) => {
          const path = new URL(req.url).pathname;
          if (req.method === 'POST' && /\/(_apis\/wit\/wiql|mcp)$/.test(path)) return true;
          return req.method === 'POST' && /\/api\/rest\/[^/]+\/(projects\/\d+\/test-cases|test-cases\/\d+\/steps)$/.test(path);
        },
        timeoutMs: 20_000,
        maxBodyBytes: 8 * 1024 * 1024,
      });
    },
  });
  scheduler = new ConnectorHealthScheduler({ connectors: new PgConnectorRepository(conn.db), tests: new PgTestRequestQueue(conn.db), intervalMs: env.CONNECTOR_HEALTH_MS ? Number(env.CONNECTOR_HEALTH_MS) : undefined });
  squash = new ConnectorExecutionManager({
      capabilities: built.capabilities,
      providers: built.providers,
      instances: new PgInstanceResolver(conn.db, (locator) => secrets.store.exists(locator)),
      policies: new PgRunPolicyStore(conn.db),
      secrets: secrets.store,
      log: new PgOperationLogSink(conn.db),
      redactor: new SecretRedactor(),
      adapterDeps: {
        http: {
          request: async (req) => {
            const rules: EgressRule[] = (await hosts.list('connector')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'connector' as const, internal: h.internal, allowHttp: h.allowHttp }));
            const http = new HardenedHttpClient({
              egress: new EgressPolicy({ rules, profile, platformEnv }),
              allowedMethods: ['GET', 'HEAD'],
              allowOther: (item) => {
                const path = new URL(item.url).pathname;
                if (item.method === 'POST' && /\/(_apis\/wit\/wiql|mcp)$/.test(path)) return true;
                return item.method === 'POST' && /\/api\/rest\/[^/]+\/(projects\/\d+\/test-cases|test-cases\/\d+\/steps)$/.test(path);
              },
              timeoutMs: 20_000,
              maxBodyBytes: 8 * 1024 * 1024,
            });
            return http.request(req);
          },
        },
      },
    });
}
const executions = conn ? new PgExecutionRepository(conn.db) : undefined;
const testCases = conn ? new TestCaseService({ cases: new PgTestCaseRepository(conn.db), audit: new PgAuditSink(new PgAuditLog(conn.db)) }) : undefined;
const environments = conn ? new PgEnvironmentRepository(conn.db) : undefined;
const loop = new WorkerLoop({
  tick: async () => {
    let busy = false;
    if (tester) {
      await scheduler?.enqueueDue();
      if ((await tester.runOnce()) === 'busy') busy = true;
    }
    if (executions && (await engineTick(executions, {
      owner: 'worker',
      now: new Date(),
      perform: async (step) => {
        const result = runFlowStep(step);
        if (step.type !== 'rv.publish-testcases' || !testCases) return result;
        const cases = (Array.isArray(result.outputs.cases) ? result.outputs.cases : []).flatMap((item) => {
          const row = item as Partial<GeneratedCase>;
          if (typeof row.name !== 'string' || typeof row.steps !== 'string' || typeof row.expected !== 'string' || typeof row.reference !== 'string') return [];
          return [{ name: row.name, steps: row.steps, expected: row.expected, workItem: typeof row.workItem === 'string' ? row.workItem : '', reference: row.reference }];
        });
        const published = await publishGeneratedCases({
          workItem: typeof result.outputs.workItem === 'string' ? result.outputs.workItem : '',
          cases,
          testCases,
          squash: squash
            ? async (item) => squash.invoke<{ id: string; created: boolean; projectId?: string }>({
                role: 'testManagement',
                capability: 'tm.testcase.upsert',
                input: { reference: item.reference, name: item.name, steps: [{ action: item.steps, expected: item.expected }] },
                idempotencyKey: item.reference,
                actor: { type: 'step', id: step.id, executionId: step.runId, stepId: step.id },
              })
            : undefined,
        });
        return { summary: published.summary, outputs: { ...result.outputs, squash: 'read-write' } };
      },
    })) === 'busy') busy = true;
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
