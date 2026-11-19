import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type {
  AdapterDeps,
  CallContext,
  CapabilityDescriptor,
  CapabilityProbeEntry,
  ConnectionTestResult,
  ConnectorClient,
  ConnectorProvider,
  HttpResponse,
  PermissionReport,
} from '@qa/connector-sdk';
import { htmlToText } from './html';
import { readTokenClaims } from './token';

const blankToUndef = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  /** Squash project name (preferred). Resolved to an id via GET /projects before list or upsert. */
  projectName: z.preprocess(blankToUndef, z.string().min(1).max(255).optional()),
  /** Numeric Squash project id. Kept for back-compat when the name is not used. */
  projectId: z.preprocess(blankToUndef, z.string().regex(/^\d+$/).optional()),
  /** @deprecated Prefer projectId. Accepted so existing connectors keep working. */
  project: z.preprocess(blankToUndef, z.string().regex(/^\d+$/).optional()),
  pageSize: z.number().int().min(1).max(200).default(50),
  maxItems: z.number().int().min(1).max(10_000).default(1_000),
  expiryWarnDays: z.number().int().min(1).max(90).default(14),
});
const SecretSchema = z.object({ token: z.string().min(20) });

type SquashConfig = Omit<z.infer<typeof ConfigSchema>, 'project'> & { projectId?: string };

export const SQUASH_PROVIDER_KEY = 'squash-tm';
export const SQUASH_SUPPORTED_CAPABILITIES = [
  'tm.capabilities.probe',
  'tm.project.list',
  'tm.testcase.list',
  'tm.testcase.read',
  'tm.testcase.search',
  'tm.testcase.upsert',
  'tm.requirement.list',
  'tm.requirement.read',
  'tm.execution.history',
  'tm.execution.upsert',
  'tm.execution.status.update',
  'tm.campaign.list',
  'tm.iteration.list',
] as const;

const NOT_AVAILABLE: Record<string, string> = {
  'tm.suite.list': 'Squash has no endpoint that lists test suites directly; they are reached through an iteration',
  'tm.tag.list': 'Squash has no endpoint that lists tags; tags appear only inside entity bodies',
  'tm.customfield.list': 'Squash has no endpoint that lists custom field definitions; values appear inside entity bodies',
  'tm.customfield.read': 'Not implemented yet; custom field values are included in testcase and requirement reads',
};

const KINDS: Record<string, 'classic' | 'scripted' | 'keyword' | 'exploratory'> = {
  'test-case': 'classic',
  'scripted-test-case': 'scripted',
  'keyword-test-case': 'keyword',
  'exploratory-test-case': 'exploratory',
};

const idOf = (v: unknown, what: string): string => {
  const s = String(v ?? '');
  if (!/^\d+$/.test(s)) throw new PlatformError('validation', `${what} must be a numeric Squash id`);
  return s;
};

interface Page {
  number: number;
  totalPages: number;
  totalElements: number;
}
type Json = Record<string, any>;

export const squashProvider: ConnectorProvider = {
  manifest: {
    providerKey: SQUASH_PROVIDER_KEY,
    category: 'test-management',
    displayName: 'SquashTM',
    description: 'Reads and stores test cases in SquashTM through its REST API. A READ_WRITE personal token stores the cases the Playwright test generator creates. A READ token can only list them.',
    authMethods: [
      {
        key: 'api_token',
        label: 'Personal API token (READ_WRITE stores generated test cases)',
        recommended: true,
        fields: [{ name: 'token', label: 'API token', secret: true, required: true }],
      },
    ],
    capabilities: [...SQUASH_SUPPORTED_CAPABILITIES],
    requiredPermissions: ['API token with READ_WRITE permission', 'Permission to create test cases in the Squash project'],
    accessModePolicy: 'read_write',
    requiresInternet: false,
    verification: 'fixtures-only',
    wizard: [
      { key: 'connection', title: 'Connection', fields: [
        { name: 'baseUrl', label: 'SquashTM address (for example http://host/squash)', type: 'url', required: true },
        { name: 'projectName', label: 'Squash project name (for example ToolKit-AgenFlow)', type: 'text', required: false },
        { name: 'projectId', label: 'Squash project id (optional; only if you prefer the numeric id)', type: 'text', required: false },
      ] },
      { key: 'credentials', title: 'API token', fields: [{ name: 'token', label: 'API token', type: 'secret', required: true }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this Squash supports', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: SecretSchema,
  create(config, secrets, deps) {
    if (!secrets) throw new PlatformError('auth', 'SquashTM needs an API token');
    const { project: legacyProject, ...parsed } = ConfigSchema.parse(config);
    const cfg: SquashConfig = { ...parsed, projectId: parsed.projectId ?? legacyProject };
    return new SquashClient(cfg, SecretSchema.parse(secrets.value).token, deps);
  },
};

class SquashClient implements ConnectorClient {
  private readonly api: string;

  constructor(
    private readonly cfg: SquashConfig,
    private readonly token: string,
    private readonly deps: AdapterDeps,
  ) {
    this.api = `${cfg.baseUrl.replace(/\/+$/, '')}/api/rest/latest`;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const claims = readTokenClaims(this.token);
    try {
      const body = await this.get('/projects', { size: 1 });
      const days = claims.expiresAt ? Math.floor((claims.expiresAt.getTime() - Date.now()) / 86_400_000) : undefined;
      const warn = days !== undefined && days <= this.cfg.expiryWarnDays;
      let projectId: string | undefined;
      let projectName: string | undefined;
      if (this.cfg.projectId || this.cfg.projectName) {
        projectId = await this.resolveProjectId(undefined);
        const match = (await this.listProjects()).find((p) => String(p.id) === projectId);
        projectName = match ? String(match.name) : this.cfg.projectName;
      }
      return {
        ok: true,
        message: warn ? `Connected. The API token expires in ${days} day(s); replace it soon.` : 'Connected to SquashTM.',
        latencyMs: Date.now() - started,
        discovered: {
          projectsVisible: (body.page as Page | undefined)?.totalElements,
          projectId,
          projectName,
          tokenPermissions: claims.permissions,
          tokenExpiresAt: claims.expiresAt?.toISOString(),
          tokenDaysToExpiry: days,
          tokenExpiryWarning: warn,
        },
      };
    } catch (e) {
      return { ok: false, message: e instanceof PlatformError ? e.message : 'Could not reach SquashTM', latencyMs: Date.now() - started };
    }
  }

  async probeCapabilities(): Promise<CapabilityProbeEntry[]> {
    const probes: [string, string][] = [
      ['tm.project.list', '/projects'],
      ['tm.testcase.list', '/test-cases'],
      ['tm.requirement.list', '/requirements'],
      ['tm.campaign.list', '/campaigns'],
      ['tm.iteration.list', '/iterations'],
    ];
    const out: CapabilityProbeEntry[] = [];
    for (const [capability, path] of probes) {
      try {
        const body = await this.get(path, { size: 1 });
        out.push({ capability, support: 'supported', evidence: { endpoint: `GET ${path}`, totalElements: (body.page as Page | undefined)?.totalElements } });
      } catch (e) {
        const err = e as PlatformError;
        out.push({ capability, support: 'unsupported', reason: err.errorClass === 'denied' ? 'The token owner cannot read this resource' : err.message, evidence: { endpoint: `GET ${path}`, errorClass: err.errorClass } });
      }
    }
    if (!out.some((o) => o.capability === 'tm.testcase.list' && o.support === 'supported')) {
      const fallback = await this.projectTestCases();
      const row = out.find((o) => o.capability === 'tm.testcase.list');
      if (fallback && row) {
        row.support = 'supported';
        row.reason = undefined;
        row.evidence = { endpoint: fallback };
      }
    }
    const supported = new Set(out.filter((o) => o.support === 'supported').map((o) => o.capability));
    out.push({
      capability: 'tm.testcase.read',
      support: supported.has('tm.testcase.list') ? 'supported' : 'unsupported',
      reason: supported.has('tm.testcase.list') ? undefined : 'Follows tm.testcase.list',
    });
    out.push({
      capability: 'tm.testcase.search',
      support: supported.has('tm.testcase.list') ? 'partial' : 'unsupported',
      reason: 'Squash has no search endpoint; the platform lists test cases and filters them itself, up to the configured item limit',
    });
    const claims = readTokenClaims(this.token);
    const canWrite = !!claims.permissions && /WRITE/i.test(claims.permissions);
    out.push({
      capability: 'tm.testcase.upsert',
      support: !supported.has('tm.testcase.list') ? 'unsupported' : canWrite ? 'supported' : 'partial',
      reason: !supported.has('tm.testcase.list')
        ? 'Follows tm.testcase.list'
        : canWrite
          ? 'POST /test-cases stores a generated case, and a later run with the same reference updates nothing'
          : 'The token does not show WRITE. Squash will refuse the store until the token is READ_WRITE.',
    });
    out.push({
      capability: 'tm.requirement.read',
      support: supported.has('tm.requirement.list') ? 'supported' : 'unsupported',
    });
    out.push({
      capability: 'tm.execution.history',
      support: supported.has('tm.testcase.list') ? 'supported' : 'unsupported',
      reason: 'Per test case: GET /test-cases/{id}/executions (checked when first used)',
    });
    out.push({
      capability: 'tm.execution.upsert',
      support: !supported.has('tm.iteration.list') ? 'unsupported' : canWrite ? 'supported' : 'partial',
      reason: !supported.has('tm.iteration.list')
        ? 'Needs an iteration list'
        : canWrite
          ? 'POST /iterations/{id}/executions records a run for a Squash test case'
          : 'The token does not show WRITE. Execution status stays on the platform until the token is READ_WRITE.',
    });
    out.push({
      capability: 'tm.execution.status.update',
      support: canWrite ? 'supported' : 'partial',
      reason: canWrite ? 'PATCH /executions/{id} sets Passed/Failed/Blocked/Skipped' : 'Needs a READ_WRITE token',
    });
    for (const [capability, reason] of Object.entries(NOT_AVAILABLE)) out.push({ capability, support: 'unsupported', reason });
    return out;
  }

  async inspectPermissions(): Promise<PermissionReport> {
    const claims = readTokenClaims(this.token);
    const perm = claims.permissions;
    return {
      granted: perm ? [`token:${perm}`] : [],
      writePermissionsDetected: perm && /WRITE/i.test(perm) ? [`token:${perm}`] : [],
      notes: [
        perm ? undefined : 'The token permission could not be read from the token; Squash still enforces it.',
        perm && /WRITE/i.test(perm)
          ? 'This token can store generated test cases in Squash.'
          : 'This token can read Squash. Storing generated test cases needs a READ_WRITE token.',
      ].filter((n): n is string => !!n),
    };
  }

  async handle(cap: CapabilityDescriptor, input: unknown, ctx: CallContext): Promise<unknown> {
    const i = (input ?? {}) as Record<string, any>;
    const signal = ctx.signal;
    const project = await this.resolveProjectId(i.project ?? ctx.scope.project, signal);
    switch (cap.id) {
      case 'tm.capabilities.probe':
        return { version: '15.0.4', capabilities: (await this.probeCapabilities()).map(({ capability, support, reason }) => ({ capability, support, reason })) };
      case 'tm.project.list':
        return this.list('/projects', 'projects', i, signal, (p) => ({ id: String(p.id), name: String(p.name) }));
      case 'tm.testcase.list':
        return this.list(project ? `/projects/${project}/test-cases` : '/test-cases', 'test-cases', i, signal, (t) => this.summary(t));
      case 'tm.testcase.search': {
        const path = project ? `/projects/${project}/test-cases` : '/test-cases';
        const all = await this.collect(path, 'test-cases', signal);
        const q = typeof i.query === 'string' ? i.query.toLowerCase() : undefined;
        const ref = typeof i.reference === 'string' ? i.reference.toLowerCase() : undefined;
        const items = all
          .filter((t) => (!q || String(t.name ?? '').toLowerCase().includes(q) || String(t.reference ?? '').toLowerCase().includes(q)) && (!ref || String(t.reference ?? '').toLowerCase() === ref))
          .map((t) => this.summary(t));
        const start = i.cursor ? Number(idOf(i.cursor, 'cursor')) : 0;
        const limit = Math.min(i.limit ?? this.cfg.pageSize, 200);
        return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : undefined };
      }
      case 'tm.testcase.read':
        return this.testCase(await this.get(`/test-cases/${idOf(i.id, 'id')}`, {}, signal));
      case 'tm.testcase.upsert':
        return this.upsert(i, project, signal);
      case 'tm.requirement.list':
        return this.list(project ? `/projects/${project}/requirements` : '/requirements', 'requirements', i, signal, (r) => ({
          id: String(r.id),
          name: String(r.name),
          reference: typeof r.reference === 'string' ? r.reference : undefined,
        }));
      case 'tm.requirement.read':
        return this.requirement(await this.get(`/requirements/${idOf(i.id, 'id')}`, {}, signal));
      case 'tm.execution.history':
        return this.list(`/test-cases/${idOf(i.testCaseId, 'testCaseId')}/executions`, 'executions', i, signal, (e) => ({
          id: String(e.id),
          status: String(e.execution_status ?? 'UNKNOWN'),
          executedOn: typeof e.last_executed_on === 'string' ? e.last_executed_on : undefined,
          executedBy: typeof e.last_executed_by === 'string' ? e.last_executed_by : undefined,
          path: typeof e.path === 'string' ? e.path : undefined,
          issueCount: typeof e.number_of_issues === 'number' ? e.number_of_issues : undefined,
        }));
      case 'tm.execution.upsert':
        return this.upsertExecution(i, signal);
      case 'tm.execution.status.update':
        return this.updateExecutionStatus(i, signal);
      case 'tm.campaign.list':
        return this.list(project ? `/projects/${project}/campaigns` : '/campaigns', 'campaigns', i, signal, (c) => ({ id: String(c.id), name: String(c.name) }));
      case 'tm.iteration.list':
        return this.list(i.campaign ? `/campaigns/${idOf(i.campaign, 'campaign')}/iterations` : '/iterations', 'iterations', i, signal, (c) => ({ id: String(c.id), name: String(c.name) }));
      default:
        throw new PlatformError('unsupported', NOT_AVAILABLE[cap.id] ?? `SquashTM does not provide ${cap.id}`);
    }
  }

  async dispose(): Promise<void> {}

  private summary(t: Json) {
    return {
      id: String(t.id),
      name: String(t.name),
      reference: typeof t.reference === 'string' && t.reference ? t.reference : undefined,
      kind: KINDS[String(t._type)],
    };
  }

  private testCase(t: Json) {
    const steps = Array.isArray(t.steps)
      ? t.steps.map((s: Json) =>
          s._type === 'call-step'
            ? { action: `Call test case "${String(s.called_test_case?.name ?? s.called_test_case?.id ?? 'unknown')}"` }
            : { action: htmlToText(s.action), expected: htmlToText(s.expected_result) || undefined },
        )
      : undefined;
    return {
      ...this.summary(t),
      automated: t.automated_test != null ? true : undefined,
      description: htmlToText(t.description) || undefined,
      prerequisite: htmlToText(t.prerequisite) || undefined,
      importance: typeof t.importance === 'string' ? t.importance : undefined,
      status: typeof t.status === 'string' ? t.status : undefined,
      script: typeof t.script === 'string' ? t.script : undefined,
      steps,
      tags: this.tags(t.custom_fields),
      customFields: this.customFields(t.custom_fields),
      lastModifiedOn: typeof t.last_modified_on === 'string' ? t.last_modified_on : undefined,
    };
  }

  private requirement(r: Json) {
    const v: Json = r.current_version ?? r;
    return {
      id: String(r.id),
      name: String(v.name ?? r.name),
      reference: typeof v.reference === 'string' && v.reference ? v.reference : undefined,
      versionNumber: typeof v.version_number === 'number' ? v.version_number : undefined,
      status: typeof v.status === 'string' ? v.status : undefined,
      criticality: typeof v.criticality === 'string' ? v.criticality : undefined,
      category: typeof v.category?.code === 'string' ? v.category.code : undefined,
      description: htmlToText(v.description) || undefined,
      tags: this.tags(v.custom_fields),
      customFields: this.customFields(v.custom_fields),
      verifyingTestCaseIds: Array.isArray(v.verifying_test_cases) ? v.verifying_test_cases.map((t: Json) => String(t.id)) : undefined,
      lastModifiedOn: typeof v.last_modified_on === 'string' ? v.last_modified_on : undefined,
    };
  }

  private tags(cfs: unknown): string[] | undefined {
    if (!Array.isArray(cfs)) return undefined;
    const tags = cfs.flatMap((c: Json) => (Array.isArray(c.value) ? c.value.map(String) : []));
    return tags.length ? tags : undefined;
  }

  private customFields(cfs: unknown): Record<string, string> | undefined {
    if (!Array.isArray(cfs) || cfs.length === 0) return undefined;
    return Object.fromEntries(cfs.map((c: Json) => [String(c.code), Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')]));
  }

  private async list(path: string, embeddedKey: string, i: Record<string, any>, signal: AbortSignal | undefined, map: (raw: Json) => unknown) {
    const size = Math.min(i.limit ?? this.cfg.pageSize, 200);
    const pageNo = i.cursor ? Number(idOf(i.cursor, 'cursor')) : 0;
    const body = await this.get(path, { page: pageNo, size }, signal);
    const raw = (body._embedded?.[embeddedKey] ?? []) as Json[];
    const page = body.page as Page | undefined;
    return { items: raw.map(map), nextCursor: page && page.number + 1 < page.totalPages ? String(page.number + 1) : undefined };
  }

  private async collect(path: string, embeddedKey: string, signal?: AbortSignal): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 0; out.length < this.cfg.maxItems; page += 1) {
      const body = await this.get(path, { page, size: Math.min(this.cfg.pageSize, 200) }, signal);
      out.push(...((body._embedded?.[embeddedKey] ?? []) as Json[]));
      const p = body.page as Page | undefined;
      if (!p || page + 1 >= p.totalPages) break;
    }
    return out.slice(0, this.cfg.maxItems);
  }

  private async upsert(i: Record<string, any>, scoped: string | undefined, signal?: AbortSignal): Promise<{ id: string; created: boolean; projectId: string }> {
    const reference = String(i.reference ?? '').trim();
    const name = String(i.name ?? '').trim();
    if (!reference || !name) throw new PlatformError('validation', 'A Squash test case needs a name and a reference.');
    const existing = await this.findByReference(reference, scoped, signal);
    if (existing) {
      const fromCase = existing.project && typeof existing.project === 'object' ? String((existing.project as Json).id ?? '') : '';
      return { id: String(existing.id), created: false, projectId: scoped ?? (/^\d+$/.test(fromCase) ? fromCase : await this.onlyProject(signal)) };
    }
    const projectId = scoped ?? await this.onlyProject(signal);
    const created = await this.send('POST', `/projects/${projectId}/test-cases`, {
      _type: 'test-case',
      name: name.slice(0, 255),
      reference: reference.slice(0, 50),
      description: '<p>Generated by playwright-test-generator.</p>',
    }, signal);
    const id = String(created.id ?? '');
    if (!/^\d+$/.test(id)) throw new PlatformError('internal', 'Squash did not return a test case id.');
    const steps = Array.isArray(i.steps) ? i.steps : [];
    for (const step of steps) {
      const action = typeof step?.action === 'string' ? step.action.trim() : '';
      if (!action) continue;
      const expected = typeof step?.expected === 'string' ? step.expected.trim() : '';
      await this.send('POST', `/test-cases/${id}/steps`, {
        _type: 'action-step',
        action: `<p>${escapeHtml(action).slice(0, 4000)}</p>`,
        expected_result: expected ? `<p>${escapeHtml(expected).slice(0, 4000)}</p>` : '',
      }, signal);
    }
    return { id, created: true, projectId };
  }

  private async findByReference(reference: string, project: string | undefined, signal?: AbortSignal): Promise<Json | undefined> {
    const path = project ? `/projects/${project}/test-cases` : '/test-cases';
    const all = await this.collect(path, 'test-cases', signal);
    return all.find((item) => String(item.reference ?? '').toLowerCase() === reference.toLowerCase());
  }

  /**
   * Capability/scope numeric id wins, then config projectId, then projectName resolved via GET /projects.
   * Returns undefined when nothing is configured so list can stay global and upsert can fall back to the first project.
   */
  private async resolveProjectId(override: unknown, signal?: AbortSignal): Promise<string | undefined> {
    if (typeof override === 'string' && override.trim()) return idOf(override, 'project');
    if (this.cfg.projectId) return idOf(this.cfg.projectId, 'project');
    if (this.cfg.projectName) return this.findProjectIdByName(this.cfg.projectName, signal);
    return undefined;
  }

  private async findProjectIdByName(name: string, signal?: AbortSignal): Promise<string> {
    const wanted = name.trim().toLowerCase();
    const matches = (await this.listProjects(signal)).filter((p) => String(p.name ?? '').trim().toLowerCase() === wanted);
    if (matches.length === 0) {
      throw new PlatformError('validation', `No Squash project named "${name.trim()}" is visible to this token.`);
    }
    if (matches.length > 1) {
      const ids = matches.map((p) => String(p.id)).join(', ');
      throw new PlatformError('validation', `Several Squash projects are named "${name.trim()}" (ids ${ids}). Set project id instead.`);
    }
    const id = String(matches[0]!.id ?? '');
    if (!/^\d+$/.test(id)) throw new PlatformError('validation', `Squash project "${name.trim()}" has no numeric id.`);
    return id;
  }

  private async listProjects(signal?: AbortSignal): Promise<Json[]> {
    return this.collect('/projects', 'projects', signal);
  }

  /** Some tokens can list one project's cases when the global test-case list is refused. */
  private async projectTestCases(): Promise<string | undefined> {
    try {
      let id: string | undefined;
      if (this.cfg.projectId || this.cfg.projectName) id = await this.resolveProjectId(undefined);
      if (!id) {
        const body = await this.get('/projects', { size: 1 });
        id = String(((body._embedded?.projects ?? []) as Json[])[0]?.id ?? '');
      }
      if (!id || !/^\d+$/.test(id)) return undefined;
      await this.get(`/projects/${id}/test-cases`, { size: 1 });
      return `GET /projects/${id}/test-cases`;
    } catch {
      return undefined;
    }
  }

  private async onlyProject(signal?: AbortSignal): Promise<string> {
    const projects = await this.listProjects(signal);
    const first = projects[0];
    if (!first || !/^\d+$/.test(String(first.id ?? ''))) throw new PlatformError('validation', 'Squash has no project this token can use, so the test case was not stored.');
    return String(first.id);
  }

  /**
   * Records an execution against the first visible iteration (or the given iterationId).
   * Project scope for ToolKit-AgenFlow (and others) stays on the connector config via projectName.
   */
  private async upsertExecution(i: Record<string, any>, signal?: AbortSignal): Promise<{ id: string; created: boolean }> {
    const testCaseId = idOf(i.testCaseId, 'testCaseId');
    const iterationId = i.iterationId ? idOf(i.iterationId, 'iterationId') : await this.firstIterationId(signal);
    const created = await this.send('POST', `/iterations/${iterationId}/executions`, {
      _type: 'execution',
      test_case: { _type: 'test-case', id: Number(testCaseId) },
      execution_status: 'READY',
    }, signal);
    const id = String(created.id ?? '');
    if (!/^\d+$/.test(id)) throw new PlatformError('internal', 'Squash did not return an execution id.');
    return { id, created: true };
  }

  private async updateExecutionStatus(i: Record<string, any>, signal?: AbortSignal): Promise<{ ok: boolean }> {
    const executionId = idOf(i.executionId, 'executionId');
    const status = String(i.status ?? '').trim().toUpperCase();
    if (!status) throw new PlatformError('validation', 'An execution status is required.');
    const actual = typeof i.actualResult === 'string' ? i.actualResult.trim() : '';
    await this.send('PATCH', `/executions/${executionId}`, {
      _type: 'execution',
      execution_status: status,
      ...(actual ? { comment: `<p>${escapeHtml(actual).slice(0, 2000)}</p>` } : {}),
    }, signal);
    return { ok: true };
  }

  private async firstIterationId(signal?: AbortSignal): Promise<string> {
    const items = await this.collect('/iterations', 'iterations', signal);
    const id = String(items[0]?.id ?? '');
    if (!/^\d+$/.test(id)) throw new PlatformError('validation', 'Squash has no iteration this token can use for an execution.');
    return id;
  }

  private async get(path: string, query: Record<string, string | number>, signal?: AbortSignal): Promise<Json> {
    return this.send('GET', path, undefined, signal, query);
  }

  private async send(method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, signal?: AbortSignal, query: Record<string, string | number> = {}): Promise<Json> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString();
    const res = await this.deps.http.request({
      method,
      url: `${this.api}${path}${qs ? `?${qs}` : ''}`,
      headers: { accept: 'application/json', authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    return this.parse(res, path, method);
  }

  private parse(res: HttpResponse, path: string, method = 'GET'): Json {
    if (res.status >= 200 && res.status < 300) {
      const type = res.headers['content-type'] ?? '';
      if (!type.includes('json')) throw new PlatformError('auth', 'SquashTM answered with a web page instead of data; the address or the token is wrong');
      return res.json<Json>();
    }
    const where = path.split('?')[0];
    if (res.status === 401) throw new PlatformError('auth', 'SquashTM rejected the API token (expired, revoked, or not a token)');
    if (res.status === 403) throw new PlatformError('denied', method === 'GET' ? `The token owner cannot read ${where}` : `The token cannot change ${where}. Store generated test cases with a READ_WRITE token.`);
    if (res.status === 404) throw new PlatformError('not-found', `SquashTM has nothing at ${where}`);
    if (res.status === 429) throw new PlatformError('rate-limited', 'SquashTM is rate limiting requests');
    if (res.status >= 500) throw new PlatformError('transient', `SquashTM answered ${res.status}`);
    throw new PlatformError('validation', `SquashTM answered ${res.status} for ${where}`);
  }
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
