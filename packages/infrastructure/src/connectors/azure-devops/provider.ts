import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { AdapterDeps, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { joinUrl, requestJson } from '../rest';

export const AZURE_DEVOPS_PROVIDER_KEY = 'azure-devops-repos';

const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  project: z.string().min(1).max(100),
  repo: z.string().min(1).max(100).optional(),
});
const SecretSchema = z.object({ token: z.string().min(20).max(500) });
const SCM = ['scm.org.list', 'scm.repo.list', 'scm.branch.list', 'scm.tree.list', 'scm.file.read', 'scm.code.search', 'scm.commit.list', 'scm.permissions.inspect'] as const;
const API = '7.1';

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cs|fs|vb|java|kt|go|rs|py|rb|php|swift|sql|xml|json|yml|yaml|css|scss|vue|svelte)$/i;
const NOISE_PATH = /(^|\/)(node_modules|dist|build|out|coverage|\.git|packages\/[^/]+\/html|sdk\/|docs\/api|wwwroot\/lib)\//i;
const HTML_ONLY = /\.(html?|htm)$/i;

/**
 * Rank Azure Repos paths for Explore code: real source first, HTML/SDK/docs last (or skipped).
 * Returns 0 when the path should not be returned as a search hit.
 */
export function azureReposSourceScore(path: string, query: string): number {
  const p = path.replace(/^\/+/, '').trim();
  if (!p) return 0;
  if (NOISE_PATH.test(p) || HTML_ONLY.test(p)) return 0;
  const q = query.trim().toLowerCase();
  if (q && !p.toLowerCase().includes(q)) return 0;
  let score = 10;
  if (SOURCE_EXT.test(p)) score += 40;
  if (/(^|\/)(src|app|apps|lib|server|client|api|services|domain)\//i.test(p)) score += 20;
  if (/(^|\/)(docs|documentation|samples?|examples?|fixtures?|vendor|third[_-]?party)\//i.test(p)) score -= 25;
  if (/\.(md|txt|lock)$/i.test(p)) score -= 5;
  // Keep query matches above zero so README-style paths still return when they are the only hit.
  return Math.max(1, score);
}

/** Scopes Azure DevOps reports on `x-vss-scopes`, when it reports them. `vso.code` is read; anything with write, manage or full is a write. */
export function azureDevOpsWriteScopes(header: string | undefined): string[] {
  return (header ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /write|manage|_full|fullaccess/i.test(s));
}

export const azureDevOpsProvider: ConnectorProvider = {
  manifest: {
    providerKey: AZURE_DEVOPS_PROVIDER_KEY,
    category: 'source-repo',
    displayName: 'Azure DevOps Repos',
    description: 'Reads projects, repositories, branches, files and commits from Azure DevOps. Create the token with Code (Read) only. This connector has been checked against recorded responses, not a live organisation.',
    authMethods: [{ key: 'pat', label: 'Personal access token with Code (Read) only', recommended: true, fields: [{ name: 'token', label: 'Access token', secret: true, required: true }] }],
    capabilities: [...SCM],
    requiredPermissions: ['Code (Read) on the project. A token that can contribute is refused when the server reports it.'],
    accessModePolicy: 'read_only_enforced',
    requiresInternet: true,
    verification: 'fixtures-only',
    wizard: [
      { key: 'connection', title: 'Project', fields: [{ name: 'baseUrl', label: 'Organisation address (https://dev.azure.com/your-org)', type: 'url', required: true }, { name: 'project', label: 'Project', type: 'text', required: true }, { name: 'repo', label: 'Repository (leave empty to allow every repository in the project)', type: 'text', required: false }] },
      { key: 'credentials', title: 'Access token', fields: [{ name: 'token', label: 'Access token', type: 'secret', required: true }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this token can read', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: SecretSchema,
  create(config, secrets, deps) {
    if (!secrets) throw new PlatformError('auth', 'Azure DevOps needs an access token');
    return new AzureDevOpsClient(ConfigSchema.parse(config), SecretSchema.parse(secrets.value).token, deps);
  },
};

class AzureDevOpsClient implements ConnectorClient {
  private readonly auth: string;

  constructor(
    private readonly cfg: z.infer<typeof ConfigSchema>,
    token: string,
    private readonly deps: AdapterDeps,
  ) {
    this.auth = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  }

  private async get(path: string, query?: Record<string, string | undefined>) {
    return requestJson(this.deps.http, { method: 'GET', url: joinUrl(this.cfg.baseUrl, path, { 'api-version': API, ...query }), headers: { authorization: this.auth, accept: 'application/json' } }, 'Azure DevOps');
  }

  /** connectionData is a preview resource. api-version 7.1 without -preview is rejected with status 400. */
  private connectionData() {
    return this.get('/_apis/connectionData', { 'api-version': '7.1-preview.1' });
  }

  private async writesFrom(headers: Record<string, string>, repos: { name?: string; permissions?: Record<string, boolean> }[]): Promise<string[]> {
    const fromHeader = azureDevOpsWriteScopes(headers['x-vss-scopes']);
    const fromRepos = repos.flatMap((r) => Object.entries(r.permissions ?? {}).filter(([, v]) => v === true).map(([k]) => `${r.name ?? 'repository'}.${k}`));
    return [...new Set([...fromHeader, ...fromRepos])];
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const conn = await this.connectionData();
      const repos = await this.get(`/${encodeURIComponent(this.cfg.project)}/_apis/git/repositories`);
      const list = (repos.body?.value ?? []) as { name?: string; permissions?: Record<string, boolean> }[];
      if (this.cfg.repo && !list.some((r) => r.name?.toLowerCase() === this.cfg.repo!.toLowerCase())) {
        const names = list.map((r) => r.name).filter((n): n is string => Boolean(n)).slice(0, 8);
        const seen = names.length > 0 ? ` Repositories in ${this.cfg.project}: ${names.join(', ')}.` : '';
        return { ok: false, message: `Repository "${this.cfg.repo}" is not in project ${this.cfg.project}.${seen}`, latencyMs: Date.now() - started };
      }
      const writes = await this.writesFrom({ ...conn.headers, ...repos.headers }, this.cfg.repo ? list.filter((r) => r.name?.toLowerCase() === this.cfg.repo!.toLowerCase()) : list);
      const reported = Boolean(conn.headers['x-vss-scopes'] || list.some((r) => r.permissions));
      return {
        ok: true,
        message: writes.length > 0 ? 'Connected, but this token can change the repository. Replace it with a Code (Read) token.' : reported ? 'Connected to Azure DevOps.' : 'Connected to Azure DevOps. The server did not report token scopes; create the token with Code (Read) only.',
        latencyMs: Date.now() - started,
        discovered: { user: conn.body?.authenticatedUser?.providerDisplayName, project: this.cfg.project, repositories: list.length, scopesReported: reported, writeScopes: writes },
      };
    } catch (e) {
      return { ok: false, message: e instanceof PlatformError ? e.message : 'Could not reach Azure DevOps', latencyMs: Date.now() - started };
    }
  }

  async inspectPermissions(): Promise<PermissionReport> {
    const conn = await this.connectionData();
    const repos = await this.get(`/${encodeURIComponent(this.cfg.project)}/_apis/git/repositories`);
    const list = (repos.body?.value ?? []) as { name?: string; permissions?: Record<string, boolean> }[];
    const writes = await this.writesFrom({ ...conn.headers, ...repos.headers }, list);
    const scopes = (conn.headers['x-vss-scopes'] ?? '').split(/[\s,]+/).filter(Boolean);
    const notes = scopes.length === 0 && writes.length === 0 ? ['Azure DevOps did not report token scopes. Create the token with Code (Read) only. This connector still sends GET requests only.'] : [];
    return { granted: scopes.length > 0 ? scopes : ['Code (Read) assumed'], writePermissionsDetected: writes, notes };
  }

  async probeCapabilities(): Promise<CapabilityProbeEntry[]> {
    const project = encodeURIComponent(this.cfg.project);
    const repo = this.cfg.repo ? encodeURIComponent(this.cfg.repo) : undefined;
    const checks: [string, () => Promise<unknown>][] = [
      ['scm.repo.list', () => this.get(`/${project}/_apis/git/repositories`)],
      ['scm.branch.list', () => (repo ? this.get(`/${project}/_apis/git/repositories/${repo}/refs`, { filter: 'heads/' }) : Promise.reject(new PlatformError('validation', 'Set a repository to list branches')))],
      ['scm.commit.list', () => (repo ? this.get(`/${project}/_apis/git/repositories/${repo}/commits`) : Promise.reject(new PlatformError('validation', 'Set a repository to list commits')))],
      ['scm.tree.list', () => (repo ? this.get(`/${project}/_apis/git/repositories/${repo}/items`, { 'recursionLevel': 'OneLevel', 'scopePath': '/' }) : Promise.reject(new PlatformError('validation', 'Set a repository to list files')))],
    ];
    const out: CapabilityProbeEntry[] = [{ capability: 'scm.org.list', support: 'partial', reason: 'Azure DevOps is scoped to the organisation in the address. This lists the configured project.' }];
    for (const [capability, run] of checks) {
      try {
        await run();
        out.push({ capability, support: 'supported' });
      } catch (e) {
        out.push({ capability, support: 'unsupported', reason: e instanceof PlatformError ? e.message : 'probe failed' });
      }
    }
    out.push({ capability: 'scm.file.read', support: out.find((o) => o.capability === 'scm.tree.list')?.support === 'supported' ? 'supported' : 'unsupported' });
    out.push({ capability: 'scm.code.search', support: 'partial', reason: 'Azure DevOps code search is not used. File paths in the selected repository are matched instead.' });
    out.push({ capability: 'scm.permissions.inspect', support: 'partial', reason: 'Scopes are reported only when the server sends them. Otherwise the token is assumed read-only and only GET is sent.' });
    return out;
  }

  async handle(cap: CapabilityDescriptor, input: unknown): Promise<unknown> {
    const i = (input ?? {}) as Record<string, string>;
    const project = encodeURIComponent(this.cfg.project);
    if (cap.id === 'scm.org.list') return { items: [{ id: this.cfg.project, name: this.cfg.project }] };
    if (cap.id === 'scm.repo.list') {
      const r = await this.get(`/${project}/_apis/git/repositories`);
      return { items: ((r.body?.value ?? []) as { id: string; name: string }[]).map((x) => ({ id: x.id, name: x.name })) };
    }
    const repo = encodeURIComponent(i.repo ?? this.cfg.repo ?? '');
    if (!repo) throw new PlatformError('validation', 'Name the repository, either on the connector or in the request');
    const base = `/${project}/_apis/git/repositories/${repo}`;
    if (cap.id === 'scm.branch.list') {
      const r = await this.get(`${base}/refs`, { filter: 'heads/' });
      return { items: ((r.body?.value ?? []) as { name: string }[]).map((x) => ({ id: x.name.replace('refs/heads/', ''), name: x.name.replace('refs/heads/', '') })) };
    }
    if (cap.id === 'scm.tree.list') {
      const r = await this.get(`${base}/items`, { recursionLevel: 'OneLevel', scopePath: i.path || '/', 'versionDescriptor.version': i.branch });
      const entries = ((r.body?.value ?? []) as { path: string; isFolder?: boolean; gitObjectType?: string }[]).map((e) => ({ path: e.path, type: e.isFolder || e.gitObjectType === 'tree' ? 'dir' as const : 'file' as const }));
      return { entries };
    }
    if (cap.id === 'scm.file.read') {
      const r = await this.get(`${base}/items`, { path: i.path, includeContent: 'true', 'versionDescriptor.version': i.branch });
      const content = String(r.body?.content ?? '');
      return { path: i.path, content: content.slice(0, 100_000), truncated: content.length > 100_000 };
    }
    if (cap.id === 'scm.commit.list') {
      const r = await this.get(`${base}/commits`, { 'searchCriteria.itemVersion.version': i.branch });
      return { items: ((r.body?.value ?? []) as { commitId: string; comment?: string; author?: { name?: string } }[]).map((c) => ({ sha: c.commitId, message: c.comment ?? '', author: c.author?.name })) };
    }
    if (cap.id === 'scm.code.search') {
      // Match human file paths in the bound Azure Repos tree (never commit SHAs).
      // Prefer application source over HTML/docs/SDK noise so Explore code visits real code.
      const q = (i.query ?? '').toLowerCase().trim();
      const r = await this.get(`${base}/items`, {
        recursionLevel: 'Full',
        scopePath: '/',
        'versionDescriptor.version': i.branch,
      });
      const entries = (r.body?.value ?? []) as { path?: string; isFolder?: boolean; gitObjectType?: string }[];
      const scored = entries
        .filter((e) => !(e.isFolder || e.gitObjectType === 'tree'))
        .map((e) => {
          const raw = typeof e.path === 'string' ? e.path : '';
          const path = raw.replace(/^\/+/, '');
          return { path, snippet: path, score: azureReposSourceScore(path, q) };
        })
        .filter((e) => e.path && e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map(({ path, snippet }) => ({ path, snippet }));
      return { items: scored };
    }
    if (cap.id === 'scm.permissions.inspect') {
      const report = await this.inspectPermissions();
      return { granted: report.granted, writePermissionsDetected: report.writePermissionsDetected };
    }
    throw new PlatformError('unsupported', `Azure DevOps does not implement ${cap.id}`);
  }

  async dispose() {}
}
