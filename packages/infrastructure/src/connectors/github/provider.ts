import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { AdapterDeps, CallContext, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { joinUrl, requestJson, required } from '../rest';

export const GITHUB_PROVIDER_KEY = 'github';

const ConfigSchema = z.object({
  baseUrl: z.string().url().default('https://api.github.com'),
  org: z.string().min(1).max(100),
  repo: z.string().min(1).max(100).optional(),
});
const SecretSchema = z.object({ token: z.string().min(20).max(500) });

const SCM = ['scm.org.list', 'scm.repo.list', 'scm.branch.list', 'scm.tree.list', 'scm.file.read', 'scm.code.search', 'scm.commit.list', 'scm.permissions.inspect'] as const;

const WRITE_SCOPE = /^(repo|public_repo|repo:status|repo_deployment|workflow|gist|delete_repo|codespace|project|notifications)$|^(admin:|write:|delete:)/;

/** Classic PAT scopes that can change a repository. `read:*` scopes are not write. */
export function githubWriteScopes(header: string | undefined): string[] {
  return (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('read:') && WRITE_SCOPE.test(s));
}

export const githubProvider: ConnectorProvider = {
  manifest: {
    providerKey: GITHUB_PROVIDER_KEY,
    category: 'source-repo',
    displayName: 'GitHub',
    description: 'Reads organisations, repositories, branches, files and commits from GitHub. The token must be read-only. The platform never commits or pushes.',
    authMethods: [{ key: 'pat', label: 'Personal access token with read access only (no repo or write scopes)', recommended: true, fields: [{ name: 'token', label: 'Access token', secret: true, required: true }] }],
    capabilities: [...SCM],
    requiredPermissions: ['A read-only token (contents: read, metadata: read). A token that can push is refused.'],
    accessModePolicy: 'read_only_enforced',
    requiresInternet: true,
    verification: 'live-capable',
    wizard: [
      { key: 'connection', title: 'Repository', fields: [{ name: 'baseUrl', label: 'API address (https://api.github.com, or your GitHub Enterprise API)', type: 'url', required: true }, { name: 'org', label: 'Organisation or user', type: 'text', required: true }, { name: 'repo', label: 'Repository (leave empty to allow every repository this token can read)', type: 'text', required: false }] },
      { key: 'credentials', title: 'Access token', fields: [{ name: 'token', label: 'Access token', type: 'secret', required: true }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this token can read', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: SecretSchema,
  create(config, secrets, deps) {
    if (!secrets) throw new PlatformError('auth', 'GitHub needs an access token');
    return new GitHubClient(ConfigSchema.parse(config), SecretSchema.parse(secrets.value).token, deps);
  },
};

class GitHubClient implements ConnectorClient {
  constructor(
    private readonly cfg: z.infer<typeof ConfigSchema>,
    private readonly token: string,
    private readonly deps: AdapterDeps,
  ) {}

  private async get(path: string, query?: Record<string, string | undefined>) {
    return requestJson(this.deps.http, { method: 'GET', url: joinUrl(this.cfg.baseUrl, path, query), headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'qa-platform' } }, 'GitHub');
  }

  private repo(input: Record<string, unknown>): string {
    const repo = String(input.repo ?? this.cfg.repo ?? '');
    if (!repo) throw new PlatformError('validation', 'Name the repository, either on the connector or in the request');
    return repo;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const user = await this.get('/user');
      const writes = githubWriteScopes(user.headers['x-oauth-scopes']);
      let repoWrites: string[] = [];
      if (this.cfg.repo) {
        const repo = await this.get(`/repos/${encodeURIComponent(this.cfg.org)}/${encodeURIComponent(this.cfg.repo)}`);
        const p = (repo.body?.permissions ?? {}) as Record<string, boolean>;
        repoWrites = ['push', 'admin', 'maintain'].filter((k) => p[k] === true);
      }
      const write = [...writes, ...repoWrites.map((k) => `repository.${k}`)];
      return {
        ok: true,
        message: write.length > 0 ? 'Connected, but this token can change the repository. Replace it with a read-only token.' : 'Connected to GitHub.',
        latencyMs: Date.now() - started,
        discovered: { login: user.body?.login, org: this.cfg.org, scopes: user.headers['x-oauth-scopes'] ?? '', writeScopes: write },
      };
    } catch (e) {
      return { ok: false, message: e instanceof PlatformError ? e.message : 'Could not reach GitHub', latencyMs: Date.now() - started };
    }
  }

  async inspectPermissions(): Promise<PermissionReport> {
    const user = await this.get('/user');
    const scopes = (user.headers['x-oauth-scopes'] ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const writes = githubWriteScopes(user.headers['x-oauth-scopes']);
    const notes = scopes.length === 0 ? ['GitHub did not report OAuth scopes. Fine-grained tokens often do this; repository permissions were checked when a repository is set.'] : [];
    if (this.cfg.repo) {
      const repo = await this.get(`/repos/${encodeURIComponent(this.cfg.org)}/${encodeURIComponent(this.cfg.repo)}`);
      const p = (repo.body?.permissions ?? {}) as Record<string, boolean>;
      for (const k of ['push', 'admin', 'maintain']) if (p[k] === true) writes.push(`repository.${k}`);
      if (p.pull === true) scopes.push('repository.pull');
    }
    return { granted: scopes.length > 0 ? scopes : ['metadata'], writePermissionsDetected: [...new Set(writes)], notes };
  }

  async probeCapabilities(): Promise<CapabilityProbeEntry[]> {
    const org = encodeURIComponent(this.cfg.org);
    const repo = this.cfg.repo ? encodeURIComponent(this.cfg.repo) : undefined;
    const checks: [string, () => Promise<unknown>][] = [
      ['scm.org.list', () => this.get('/user/orgs')],
      ['scm.repo.list', () => this.get(`/orgs/${org}/repos`, { per_page: '1' })],
      ['scm.branch.list', () => (repo ? this.get(`/repos/${org}/${repo}/branches`, { per_page: '1' }) : Promise.reject(new PlatformError('validation', 'Set a repository to list branches')))],
      ['scm.tree.list', () => (repo ? this.get(`/repos/${org}/${repo}/contents/`) : Promise.reject(new PlatformError('validation', 'Set a repository to list files')))],
      ['scm.commit.list', () => (repo ? this.get(`/repos/${org}/${repo}/commits`, { per_page: '1' }) : Promise.reject(new PlatformError('validation', 'Set a repository to list commits')))],
      ['scm.code.search', () => this.get('/search/code', { q: `repo:${this.cfg.org}/${this.cfg.repo ?? ''}`.replace(/\/$/, ''), per_page: '1' })],
    ];
    const out: CapabilityProbeEntry[] = [];
    for (const [capability, run] of checks) {
      try {
        await run();
        out.push({ capability, support: 'supported' });
      } catch (e) {
        const err = e instanceof PlatformError ? e : new PlatformError('transient', 'probe failed');
        out.push({ capability, support: capability === 'scm.code.search' && err.errorClass === 'denied' ? 'partial' : 'unsupported', reason: err.message });
      }
    }
    const tree = out.find((o) => o.capability === 'scm.tree.list');
    out.push({ capability: 'scm.file.read', support: tree?.support === 'supported' ? 'supported' : 'unsupported', reason: tree?.support === 'supported' ? undefined : 'Follows the file listing' });
    out.push({ capability: 'scm.permissions.inspect', support: 'supported' });
    return out;
  }

  async handle(cap: CapabilityDescriptor, input: unknown, _ctx: CallContext): Promise<unknown> {
    const i = (input ?? {}) as Record<string, string>;
    const org = encodeURIComponent(i.org ?? this.cfg.org);
    const orgName = i.org ?? this.cfg.org;
    if (cap.id === 'scm.org.list') {
      const r = await this.get('/user/orgs', { per_page: '100' });
      const items = (Array.isArray(r.body) ? r.body : []).map((o: { id: number; login: string }) => ({ id: String(o.id), name: o.login }));
      return { items };
    }
    if (cap.id === 'scm.repo.list') {
      const r = await this.get(`/orgs/${org}/repos`, { per_page: '100' });
      return { items: (Array.isArray(r.body) ? r.body : []).map((o: { id: number; name: string }) => ({ id: String(o.id), name: o.name })) };
    }
    const repo = encodeURIComponent(this.repo(i));
    if (cap.id === 'scm.branch.list') {
      const r = await this.get(`/repos/${org}/${repo}/branches`, { per_page: '100' });
      return { items: (Array.isArray(r.body) ? r.body : []).map((b: { name: string }) => ({ id: b.name, name: b.name })) };
    }
    if (cap.id === 'scm.tree.list') {
      const r = await this.get(`/repos/${org}/${repo}/contents/${encodeURIComponent(i.path ?? '').replace(/%2F/g, '/')}`, { ref: i.branch });
      const entries = (Array.isArray(r.body) ? r.body : [r.body]).filter(Boolean).map((e: { path: string; type: string; size?: number }) => ({ path: e.path, type: e.type === 'dir' ? 'dir' : 'file', sizeBytes: e.size }));
      return { entries };
    }
    if (cap.id === 'scm.file.read') {
      const file = required(i.path, 'File path');
      const r = await this.get(`/repos/${org}/${repo}/contents/${encodeURIComponent(file).replace(/%2F/g, '/')}`, { ref: i.branch });
      const raw = typeof r.body?.content === 'string' ? Buffer.from(r.body.content.replace(/\n/g, ''), 'base64').toString('utf8') : '';
      const truncated = raw.length > 100_000;
      return { path: file, content: raw.slice(0, 100_000), truncated };
    }
    if (cap.id === 'scm.code.search') {
      const r = await this.get('/search/code', { q: `${i.query} repo:${orgName}/${this.repo(i)}` });
      const items = (r.body?.items ?? []).map((hit: { path: string; text_matches?: { fragment?: string }[] }) => ({ path: hit.path, snippet: hit.text_matches?.[0]?.fragment ?? '' }));
      return { items };
    }
    if (cap.id === 'scm.commit.list') {
      const r = await this.get(`/repos/${org}/${repo}/commits`, { sha: i.branch, per_page: '30' });
      return { items: (Array.isArray(r.body) ? r.body : []).map((c: { sha: string; commit?: { message?: string; author?: { name?: string } } }) => ({ sha: c.sha, message: c.commit?.message ?? '', author: c.commit?.author?.name })) };
    }
    if (cap.id === 'scm.permissions.inspect') {
      const report = await this.inspectPermissions();
      return { granted: report.granted, writePermissionsDetected: report.writePermissionsDetected };
    }
    throw new PlatformError('unsupported', `GitHub does not implement ${cap.id}`);
  }

  async dispose() {}
}
