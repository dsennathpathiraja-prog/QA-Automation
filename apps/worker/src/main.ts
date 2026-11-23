import {
  browserPortFromInvoker,
  createBrowserExplorer,
  createCodeExplorer,
  createLlmTestGenerator,
  createLlmTestHealer,
  createLlmTestPlanner,
  sourceRepoPortFromInvoker,
  PLAYWRIGHT_TEST_GENERATOR,
  PLAYWRIGHT_TEST_HEALER,
  PLAYWRIGHT_TEST_PLANNER,
  type PlannerScenario,
} from '@qa/agents';
import { buildProviders, buildSecretStore, connectDatabase } from '@qa/bootstrap';
import { ConnectorExecutionManager } from '@qa/connector-sdk';
import { PlatformError, type DeploymentProfile, type PlatformEnv } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, OllamaAdapter, OpenAiCompatibleAdapter, RemoteRunnerLauncher, initTelemetry, readSecretFile, type EgressRule } from '@qa/infrastructure';
import { LlmGateway, StaticAssignmentResolver, StaticProviderRegistry, type DataClass, type LlmPort, type ProviderEntry } from '@qa/llm';
import { SecretRedactor } from '@qa/security';
import { tick as engineTick } from '@qa/workflow-engine';
import { AutomationService, caseIdsFromPlatformCollection, RegressionCollectionService, TestCaseService } from '@qa/application';
import { DEFAULT_PROJECT_ID, PgApprovedHostRepository, PgAuditLog, PgAuditSink, PgAutomationRepository, PgConnectorRepository, PgEnvironmentRepository, PgExecutionRepository, PgInstanceResolver, PgLlmAuditSink, PgOperationLogSink, PgRegressionCollectionRepository, PgRunPolicyStore, PgTestCaseRepository, PgTestRequestQueue, pingDb, seedRegressionCollections } from '@qa/persistence';
import { publishGeneratedCases, type GeneratedCase } from './publish-cases';
import { buildWorkerApp } from './app';
import { ConnectorTester } from './connector-tester';
import {
  performConfigureScope,
  performSelectSquashProject,
  squashPortFromInvoker,
} from './configure-scope';
import { ConnectorHealthScheduler } from './health-scheduler';
import { WorkerLoop } from './loop';
import { checkReachability } from './reachability';
import { enrichStoryFromConnector } from './read-story';
import { performExecuteTests } from './execute-tests';
import { parseReportCases, performRegressionReport, type PreviousRegressionRun } from './regression-report';
import { performResolveAutomation } from './resolve-automation';
import { performRequirementStep } from './requirement-agents';
import { launcherDown, runReachabilityCheck } from './runner-check';
import { launcherDown as workItemLauncherDown, processWorkItemExecutions, runWorkItemCases } from './run-work-item';
import { performSelectEnvironment } from './select-environment';
import { squashIdFromSummary, syncCaseResultsToSquash } from './sync-execution';
import { performUpdateSquash } from './update-squash';

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
              allowOther: (item) => squashWriteAllowed(item.method, new URL(item.url).pathname),
              timeoutMs: 20_000,
              maxBodyBytes: 8 * 1024 * 1024,
            });
            return http.request(req);
          },
        },
      },
    });
  tester = new ConnectorTester({
    connectors: new PgConnectorRepository(conn.db),
    tests: new PgTestRequestQueue(conn.db),
    secrets: secrets.store,
    providers: built.providers,
    capabilities: built.capabilities,
    audit: new PgAuditSink(new PgAuditLog(conn.db)),
    // Test connection bypasses invoke(); clear the Explore UI circuit so evaluate works immediately.
    onTestSucceeded: (connectorId) => squash?.resetCircuit(connectorId),
    http: async () => {
      const rules: EgressRule[] = (await hosts.list('connector')).map((h) => ({ hostPattern: h.hostPattern, purpose: 'connector', internal: h.internal, allowHttp: h.allowHttp }));
      return new HardenedHttpClient({
        egress: new EgressPolicy({ rules, profile, platformEnv }),
        allowedMethods: ['GET', 'HEAD'],
        // Work-item search, the Playwright server, and storing a generated Squash test case are the only writes a connector may send.
        allowOther: (req) => squashWriteAllowed(req.method, new URL(req.url).pathname),
        timeoutMs: 20_000,
        maxBodyBytes: 8 * 1024 * 1024,
      });
    },
  });
  scheduler = new ConnectorHealthScheduler({ connectors: new PgConnectorRepository(conn.db), tests: new PgTestRequestQueue(conn.db), intervalMs: env.CONNECTOR_HEALTH_MS ? Number(env.CONNECTOR_HEALTH_MS) : undefined });
}

/** Work-item search, Playwright MCP, Squash test-case store, execution status, and screenshot attachments. */
function squashWriteAllowed(method: string, path: string): boolean {
  if (method === 'POST' && /\/(_apis\/wit\/wiql|mcp)$/.test(path)) return true;
  if (method === 'POST' && /\/api\/rest\/[^/]+\/(test-cases(\/\d+\/steps)?|iterations\/\d+\/executions|(executions|test-cases)\/\d+\/attachments\/?)$/.test(path)) return true;
  if (method === 'DELETE' && /\/api\/rest\/[^/]+\/test-steps\/\d+$/.test(path)) return true;
  return method === 'PATCH' && /\/api\/rest\/[^/]+\/(test-cases|executions)\/\d+$/.test(path);
}
const executions = conn ? new PgExecutionRepository(conn.db) : undefined;
const testCases = conn ? new TestCaseService({ cases: new PgTestCaseRepository(conn.db), audit: new PgAuditSink(new PgAuditLog(conn.db)) }) : undefined;
const automation = conn
  ? new AutomationService({ automation: new PgAutomationRepository(conn.db), audit: new PgAuditSink(new PgAuditLog(conn.db)) })
  : undefined;
const regressionCollections = conn
  ? new RegressionCollectionService({
    collections: new PgRegressionCollectionRepository(conn.db),
    audit: new PgAuditSink(new PgAuditLog(conn.db)),
  })
  : undefined;
if (conn) {
  void seedRegressionCollections(conn.db).catch((err) => log('regression collection seed failed', { error: String(err) }));
}
const environments = conn ? new PgEnvironmentRepository(conn.db) : undefined;

const ALL_DATA_CLASSES: DataClass[] = ['story', 'code', 'page', 'screenshot', 'test-data', 'evidence'];

/** Local Ollama / vLLM gateway for playwright-test-planner and playwright-test-generator. Absent when neither URL is set. */
function buildRequirementLlm(): LlmGateway | undefined {
  const ollamaUrl = env.OLLAMA_URL;
  const vllmUrl = env.VLLM_URL;
  if (!ollamaUrl && !vllmUrl) return undefined;
  const rules: EgressRule[] = [];
  for (const u of [ollamaUrl, vllmUrl].filter((x): x is string => !!x)) {
    const url = new URL(u);
    rules.push({ hostPattern: url.hostname, purpose: 'llm', internal: true, allowHttp: url.protocol === 'http:', allowLoopback: true });
  }
  const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile, platformEnv }), allowedMethods: ['GET', 'POST'], timeoutMs: 300_000, maxBodyBytes: 16 * 1024 * 1024 });
  const entries: ProviderEntry[] = [];
  const add = (id: string, port: LlmPort, model: string) => {
    entries.push({
      descriptor: {
        id,
        kind: 'local',
        enabled: true,
        allowedDataClasses: ALL_DATA_CLASSES,
        concurrencySlots: 1,
        models: [{ name: model, supportsStructuredOutput: true }],
      },
      port,
    });
  };
  const ollamaModel = env.OLLAMA_MODEL || 'qwen2.5:7b';
  const vllmModel = env.VLLM_MODEL || 'default';
  if (ollamaUrl) add('ollama', new OllamaAdapter({ baseUrl: ollamaUrl, http, keepAlive: env.OLLAMA_KEEP_ALIVE }), ollamaModel);
  if (vllmUrl) {
    const apiKey = env.VLLM_API_KEY_FILE ? readSecretFile(env.VLLM_API_KEY_FILE) : undefined;
    add('vllm', new OpenAiCompatibleAdapter({ baseUrl: vllmUrl, http, apiKey, adapterName: 'vllm' }), vllmModel);
  }
  if (entries.length === 0) return undefined;
  const primary = entries[0]!;
  const model = primary.descriptor.models[0]!.name;
  const assignment = { primary: { providerId: primary.descriptor.id, model }, maxOutputTokens: 4_096, temperature: 0.1 };
  const redactor = new SecretRedactor();
  return new LlmGateway({
    registry: new StaticProviderRegistry(entries),
    assignments: new StaticAssignmentResolver({
      [PLAYWRIGHT_TEST_PLANNER]: assignment,
      [PLAYWRIGHT_TEST_GENERATOR]: assignment,
      [PLAYWRIGHT_TEST_HEALER]: assignment,
    }),
    redactor: { redact: (s) => redactor.redactString(s) },
    audit: conn ? new PgLlmAuditSink(conn.db) : { append: async () => undefined },
    profile: profile === 'airgapped' ? 'airgapped' : profile === 'restricted' ? 'restricted' : 'standard',
  });
}

const requirementLlm = buildRequirementLlm();
const plannerPort = createLlmTestPlanner(requirementLlm);
const generatorPort = createLlmTestGenerator(requirementLlm);
const healerPort = createLlmTestHealer(requirementLlm);

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
      onCancel: async (runId) => {
        const launcherUrl = env.RUNNER_LAUNCHER_URL;
        const launcherToken = env.RUNNER_LAUNCHER_TOKEN_FILE ? readSecretFile(env.RUNNER_LAUNCHER_TOKEN_FILE) : env.RUNNER_LAUNCHER_TOKEN;
        if (!launcherUrl || !launcherToken) return;
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
          await launcher.cancelByExecution(runId.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || runId, 'workflow run cancelled');
        } catch {
          /* best-effort — cancel still clears the lease */
        }
      },
      perform: async (step) => {
        if (step.type === 'rg.select-squash-project') {
          return performSelectSquashProject(step);
        }
        if (step.type === 'rg.configure-scope') {
          const actor = { type: 'step' as const, id: step.id, executionId: step.runId, stepId: step.id };
          const squashPort = squash
            ? squashPortFromInvoker(async (capability, input) => squash.invoke({
              role: 'testManagement',
              capability,
              input,
              actor,
            }))
            : undefined;
          const collections = regressionCollections || (testCases && automation)
            ? {
              caseIdsForCollectionKey: async (key: string) => {
                if (regressionCollections) {
                  const curated = await regressionCollections.caseIdsForKey(key);
                  if (curated !== undefined) return curated;
                }
                if (!testCases || !automation) return undefined;
                const run = await executions?.get(step.runId);
                const projectId = run?.projectId ?? DEFAULT_PROJECT_ID;
                return caseIdsFromPlatformCollection({
                  collectionKey: key,
                  listCollections: () => testCases.collections({ projectId }),
                  getCollection: (id) => testCases.collection(id).then((c) => c ? { cases: c.cases } : undefined).catch(() => undefined),
                  listAssets: () => automation.listAssets(),
                  listMappings: () => automation.listMappings(),
                });
              },
            }
            : undefined;
          return performConfigureScope(step, { squash: squashPort, collections });
        }
        if (step.type === 'rg.resolve-automation') {
          return performResolveAutomation(step, automation);
        }
        if (step.type === 'rg.select-environment') {
          return performSelectEnvironment(
            step,
            environments
              ? async (id) => {
                  const row = await environments.get(id);
                  if (!row?.applicationUrl) return undefined;
                  return { id: row.id, name: row.name, applicationUrl: row.applicationUrl };
                }
              : undefined,
          );
        }
        if (step.type === 'rg.execute-tests') {
          return performExecuteTests(step, {
            testCases,
            resolveEnvironment: environments
              ? async (id) => {
                  const row = await environments.get(id);
                  if (!row?.applicationUrl) return undefined;
                  return { id: row.id, name: row.name, applicationUrl: row.applicationUrl };
                }
              : undefined,
            runCases: async ({ run, cases, url, onProgress }) => {
              const launcherUrl = env.RUNNER_LAUNCHER_URL;
              const launcherToken = env.RUNNER_LAUNCHER_TOKEN_FILE ? readSecretFile(env.RUNNER_LAUNCHER_TOKEN_FILE) : env.RUNNER_LAUNCHER_TOKEN;
              if (!launcherUrl || !launcherToken) {
                return runWorkItemCases({ run, cases, url, onProgress });
              }
              try {
                const launcherHost = new URL(launcherUrl);
                const http = new HardenedHttpClient({
                  egress: new EgressPolicy({
                    rules: [{ hostPattern: launcherHost.hostname, purpose: 'platform', internal: true, allowHttp: launcherHost.protocol === 'http:', allowLoopback: launcherHost.hostname === 'localhost' || launcherHost.hostname === '127.0.0.1' }],
                    profile,
                    platformEnv,
                  }),
                  allowedMethods: ['GET', 'POST'],
                  timeoutMs: 60_000,
                  maxBodyBytes: 32 * 1024 * 1024,
                });
                const launcher = new RemoteRunnerLauncher({ baseUrl: launcherUrl, token: () => launcherToken, http });
                const image = await launcher.image();
                return await runWorkItemCases({
                  run,
                  cases,
                  url,
                  onProgress,
                  launcher: { launcher, image, logs: (id) => launcher.logs(id) },
                });
              } catch (e) {
                if (workItemLauncherDown(e) || launcherDown(e)) {
                  return runWorkItemCases({ run, cases, url, onProgress });
                }
                if (e instanceof PlatformError) throw e;
                throw new PlatformError('internal', 'The runner could not be started.');
              }
            },
          });
        }
        if (step.type === 'rg.update-squash') {
          return performUpdateSquash(step, {
            testCases,
            resolveWritable: squash && conn
              ? async () => {
                  const connectors = new PgConnectorRepository(conn.db);
                  const candidates = (await connectors.list()).filter((c) => c.category === 'test-management' && c.enabled && c.accessMode === 'read_write');
                  let squashInstance = candidates[0];
                  for (const candidate of candidates) {
                    const states = await connectors.capabilityStates(candidate.id);
                    if (states.some((s) => s.capability === 'tm.execution.upsert' && s.granted)) {
                      squashInstance = candidate;
                      break;
                    }
                  }
                  if (!squashInstance) return undefined;
                  const states = await connectors.capabilityStates(squashInstance.id);
                  if (!states.some((s) => s.capability === 'tm.execution.upsert' && s.granted)) return undefined;
                  const actor = { type: 'user' as const, id: 'worker', permissions: ['connector.manage'] };
                  const workItemKey = `rg:${step.runId}`.slice(0, 120);
                  return {
                    upsert: async (testCaseId: string) => squash.invoke<{ id: string; created: boolean }>({
                      connectorInstanceId: squashInstance.id,
                      capability: 'tm.execution.upsert',
                      input: { testCaseId },
                      idempotencyKey: `rg-exec-${workItemKey}-${testCaseId}`,
                      actor,
                    }),
                    updateStatus: async (executionId: string, status: string, actualResult?: string) => {
                      await squash.invoke({
                        connectorInstanceId: squashInstance.id,
                        capability: 'tm.execution.status.update',
                        input: { executionId, status, actualResult },
                        actor,
                      });
                    },
                    uploadAttachment: async ({ executionId, testCaseId, name, contentBase64, sha256 }) =>
                      squash.invoke<{ id: string }>({
                        connectorInstanceId: squashInstance.id,
                        capability: 'tm.attachment.upload',
                        input: { entityType: 'execution', entityId: executionId, name, contentBase64, sha256 },
                        idempotencyKey: `rg-attach-${workItemKey}-${testCaseId}-${executionId}-${sha256.slice(0, 16)}`,
                        actor,
                      }),
                  };
                }
              : undefined,
          });
        }
        if (step.type === 'rg.regression-report') {
          return performRegressionReport(step, {
            findPreviousRun: testCases
              ? async ({ evidenceExecutionId, environmentId }) => {
                  const board = await testCases.executionBoard();
                  const candidates = board.items
                    .filter((item) => item.workItem.startsWith('rg:'))
                    .filter((item) => item.status === 'completed' || item.status === 'failed')
                    .filter((item) => !environmentId || item.environmentId === environmentId)
                    .filter((item) => !evidenceExecutionId || item.id !== evidenceExecutionId)
                    .sort((a, b) => {
                      const ta = a.finishedAt ?? a.createdAt;
                      const tb = b.finishedAt ?? b.createdAt;
                      return tb.localeCompare(ta);
                    });
                  const previous = candidates[0];
                  if (!previous?.results) return undefined;
                  const mapped: PreviousRegressionRun = {
                    id: previous.id,
                    workItem: previous.workItem,
                    finishedAt: previous.finishedAt,
                    environmentId: previous.environmentId,
                    results: parseReportCases(previous.results.map((r) => ({
                      testCaseId: r.testCaseId,
                      name: r.name,
                      status: r.status,
                      message: r.message,
                      hasScreenshot: r.hasScreenshot,
                      squashExecutionId: r.squashExecutionId,
                    }))),
                  };
                  return mapped;
                }
              : undefined,
          });
        }
        let params = step.params;
        if (step.type === 'rv.read-user-story') {
          const enrich = await enrichStoryFromConnector({
            story: typeof step.params.story === 'string' ? step.params.story : '',
            connectors: squash,
            actor: { type: 'step', id: step.id, executionId: step.runId, stepId: step.id },
          });
          if (enrich.status === 'enriched') {
            params = {
              ...step.params,
              story: enrich.enrichment.story,
              workItemTitle: enrich.enrichment.title,
              workItemFields: enrich.enrichment.fields,
              ...(enrich.enrichment.descriptionExcerpt
                ? { workItemDescriptionExcerpt: enrich.enrichment.descriptionExcerpt }
                : {}),
            };
          } else if (enrich.status === 'missed') {
            // Work item id was supplied but title was not loaded — fail clearly (do not soft-skip).
            throw new PlatformError(
              'validation',
              enrich.reason || `Could not load work item ${enrich.workItem} from the bound Azure Boards connector.`,
            );
          }
        }
        const actor = { type: 'step' as const, id: step.id, executionId: step.runId, stepId: step.id };
        const explorer = createBrowserExplorer(
          squash
            ? browserPortFromInvoker(async (capability, input) => squash.invoke({
              role: 'browserAutomation',
              capability,
              input: input ?? {},
              actor,
            }))
            : undefined,
        );
        const codeExplorer = createCodeExplorer(
          squash
            ? sourceRepoPortFromInvoker(async (capability, input) => squash.invoke({
              role: 'sourceRepo',
              capability,
              input: input ?? {},
              actor,
            }))
            : undefined,
        );
        const result = await performRequirementStep(
          { ...step, params },
          {
            planner: plannerPort,
            generator: generatorPort,
            healer: healerPort,
            explorer,
            codeExplorer,
            resolveEnvironmentUrl: environments
              ? async (id) => {
                const row = await environments.get(id);
                return row?.applicationUrl;
              }
              : undefined,
            resolveTemplatePreviewUrl: environments
              ? async (id) => {
                const row = await environments.get(id);
                const fromEnv = typeof row?.templatePreviewUrl === 'string' ? row.templatePreviewUrl.trim() : '';
                const fromProcess = (process.env.QA_TEMPLATE_PREVIEW_URL || '').trim();
                return fromEnv || fromProcess || undefined;
              }
              : async () => {
                const fromProcess = (process.env.QA_TEMPLATE_PREVIEW_URL || '').trim();
                return fromProcess || undefined;
              },
          },
        );
        if (step.type !== 'rv.publish-testcases' || !testCases) return result;
        const cases: GeneratedCase[] = (Array.isArray(result.outputs.cases) ? result.outputs.cases : []).flatMap((item) => {
          const row = item as Partial<GeneratedCase> & { validationSteps?: { action?: string; expected?: string }[]; file?: string };
          if (typeof row.name !== 'string' || typeof row.steps !== 'string' || typeof row.expected !== 'string' || typeof row.reference !== 'string') return [];
          const kind: GeneratedCase['kind'] = row.kind === 'negative' || row.kind === 'edge' || row.kind === 'positive' ? row.kind : undefined;
          const priority: GeneratedCase['priority'] = row.priority === 'high' || row.priority === 'medium' || row.priority === 'low' ? row.priority : undefined;
          const validationSteps = Array.isArray(row.validationSteps)
            ? row.validationSteps.flatMap((s) => {
              const action = typeof s?.action === 'string' ? s.action.trim() : '';
              if (!action) return [];
              return [{ action, expected: typeof s?.expected === 'string' ? s.expected : '' }];
            })
            : undefined;
          const tags = Array.isArray((row as { tags?: unknown }).tags)
            ? ((row as { tags?: unknown[] }).tags ?? []).flatMap((t) => (typeof t === 'string' && t.trim() ? [t.trim()] : []))
            : undefined;
          const runStatus = (row as { runStatus?: unknown }).runStatus === 'Blocked' || (row as { runStatus?: unknown }).runStatus === 'Skipped'
            ? (row as { runStatus: 'Blocked' | 'Skipped' }).runStatus
            : undefined;
          const surfaceKind = (row as { surfaceKind?: unknown }).surfaceKind;
          return [{
            name: row.name,
            steps: row.steps,
            expected: row.expected,
            workItem: typeof row.workItem === 'string' ? row.workItem : '',
            reference: row.reference,
            kind,
            priority,
            validationSteps,
            file: typeof row.file === 'string' ? row.file : undefined,
            ...(runStatus ? { runStatus } : {}),
            ...(tags && tags.length > 0 ? { tags } : {}),
            ...(typeof (row as { primarySurfaceUrl?: unknown }).primarySurfaceUrl === 'string'
              ? { primarySurfaceUrl: (row as { primarySurfaceUrl: string }).primarySurfaceUrl }
              : {}),
            ...(surfaceKind === 'shop' || surfaceKind === 'template' || surfaceKind === 'other'
              ? { surfaceKind }
              : {}),
          }];
        });
        const storyOut = step.prior.read_story ?? {};
        const planOut = step.prior.plan ?? {};
        const criteria = Array.isArray(storyOut.acceptanceCriteria)
          ? storyOut.acceptanceCriteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          : [];
        const scenarios = Array.isArray(planOut.scenarios) ? planOut.scenarios : undefined;
        const planMarkdown = typeof planOut.planMarkdown === 'string' ? planOut.planMarkdown : undefined;
        const blockingGap = planOut.blockingGap === true
          || (typeof planOut.exploreWarning === 'string' && /blocking explore gap/i.test(planOut.exploreWarning));
        const run = await executions?.get(step.runId);
        const platformProjectId = run?.projectId ?? DEFAULT_PROJECT_ID;
        const published = await publishGeneratedCases({
          workItem: typeof result.outputs.workItem === 'string' ? result.outputs.workItem : '',
          cases,
          testCases,
          platformProjectId,
          automation,
          criteria,
          scenarios: scenarios as PlannerScenario[] | undefined,
          planMarkdown,
          blockingGap,
          squash: squash
            ? async (_item, upsert) => squash.invoke<{ id: string; created: boolean; projectId?: string }>({
                role: 'testManagement',
                capability: 'tm.testcase.upsert',
                input: {
                  reference: upsert.reference,
                  name: upsert.name,
                  description: upsert.description,
                  steps: upsert.steps,
                },
                idempotencyKey: upsert.reference,
                actor: { type: 'step', id: step.id, executionId: step.runId, stepId: step.id },
              })
            : undefined,
        });
        return {
          summary: published.summary,
          outputs: {
            ...result.outputs,
            squash: 'read-write',
            qualityGate: published.quality
              ? {
                ok: published.quality.ok,
                summary: published.quality.summary,
                stubCount: published.quality.stubCount,
                needsSurfaceCount: published.quality.needsSurfaceCount,
                acGaps: published.quality.acCoverage.filter((r) => !r.covered).map((r) => r.criterion),
              }
              : undefined,
          },
        };
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
    if (testCases && environments && hosts && (await processWorkItemExecutions({
      testCases,
      resolveUrl: async (environmentId) => {
        const row = await environments.get(environmentId);
        if (!row?.applicationUrl) throw new PlatformError('not-found', 'That environment was not found.');
        return row.applicationUrl;
      },
      run: async ({ run, cases, url, onProgress, isCancelled }) => {
        // Executions require Playwright via runner-launcher — never HTTP probe-pass without screenshots.
        const launcherUrl = env.RUNNER_LAUNCHER_URL;
        const launcherToken = env.RUNNER_LAUNCHER_TOKEN_FILE ? readSecretFile(env.RUNNER_LAUNCHER_TOKEN_FILE) : env.RUNNER_LAUNCHER_TOKEN;
        if (!launcherUrl || !launcherToken) {
          return runWorkItemCases({ run, cases, url, onProgress, isCancelled });
        }
        try {
          const launcherHost = new URL(launcherUrl);
          const http = new HardenedHttpClient({
            egress: new EgressPolicy({
              rules: [{ hostPattern: launcherHost.hostname, purpose: 'platform', internal: true, allowHttp: launcherHost.protocol === 'http:', allowLoopback: launcherHost.hostname === 'localhost' || launcherHost.hostname === '127.0.0.1' }],
              profile,
              platformEnv,
            }),
            allowedMethods: ['GET', 'POST'],
            timeoutMs: 60_000,
            // RESULT_JSON carries status; SCREENSHOT_JSON carries compact JPEG evidence per case.
            maxBodyBytes: 32 * 1024 * 1024,
          });
          const launcher = new RemoteRunnerLauncher({ baseUrl: launcherUrl, token: () => launcherToken, http });
          const image = await launcher.image();
          return await runWorkItemCases({
            run,
            cases,
            url,
            onProgress,
            isCancelled,
            launcher: { launcher, image, logs: (id) => launcher.logs(id) },
          });
        } catch (e) {
          if (workItemLauncherDown(e) || launcherDown(e)) {
            return runWorkItemCases({ run, cases, url, onProgress, isCancelled });
          }
          if (e instanceof PlatformError) throw e;
          throw new PlatformError('internal', 'The runner could not be started.');
        }
      },
      syncSquash: squash && conn
        ? async (results, workItem) => {
            const connectors = new PgConnectorRepository(conn.db);
            const candidates = (await connectors.list()).filter((c) => c.category === 'test-management' && c.enabled && c.accessMode === 'read_write');
            let squashInstance = candidates[0];
            for (const candidate of candidates) {
              const states = await connectors.capabilityStates(candidate.id);
              if (states.some((s) => s.capability === 'tm.execution.upsert' && s.granted)) {
                squashInstance = candidate;
                break;
              }
            }
            if (!squashInstance) {
              return { results, summary: `Cases ran for ${workItem}. No writable Squash connector is switched on.` };
            }
            const actor = { type: 'user' as const, id: 'worker', permissions: ['connector.manage'] };
            return syncCaseResultsToSquash({
              results,
              workItem,
              squashIdForCase: async (testCaseId) => {
                const view = await testCases.get(testCaseId);
                return squashIdFromSummary(view.summary);
              },
              upsert: async (testCaseId) => squash.invoke<{ id: string; created: boolean }>({
                connectorInstanceId: squashInstance.id,
                capability: 'tm.execution.upsert',
                input: { testCaseId },
                idempotencyKey: `exec-${workItem}-${testCaseId}`,
                actor,
              }),
              updateStatus: async (executionId, status, actualResult) => {
                await squash.invoke({
                  connectorInstanceId: squashInstance.id,
                  capability: 'tm.execution.status.update',
                  input: { executionId, status, actualResult },
                  actor,
                });
              },
              uploadAttachment: async ({ executionId, testCaseId, name, contentBase64, sha256 }) =>
                squash.invoke<{ id: string }>({
                  connectorInstanceId: squashInstance.id,
                  capability: 'tm.attachment.upload',
                  input: { entityType: 'execution', entityId: executionId, name, contentBase64, sha256 },
                  idempotencyKey: `attach-${workItem}-${testCaseId}-${executionId}-${sha256.slice(0, 16)}`,
                  actor,
                }),
            });
          }
        : undefined,
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
log('worker started', {
  profile,
  database: conn ? 'configured' : 'none',
  secretStore: secrets?.kind ?? 'none',
  connectorTests: tester ? 'enabled' : 'disabled',
  requirementAgents: requirementLlm ? 'model' : 'heuristic',
});
