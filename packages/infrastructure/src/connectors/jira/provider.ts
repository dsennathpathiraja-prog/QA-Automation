import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { AdapterDeps, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { acceptanceCriteriaFromDescription, textOf } from '../acceptance-criteria';
import { downloadBytes, joinUrl, requestJson, required } from '../rest';

export const JIRA_PROVIDER_KEY = 'jira';

const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email().optional(),
  /** When set, acceptance criteria are read from this field instead of the description. */
  acceptanceCriteriaField: z.string().min(1).max(100).optional(),
});
const SecretSchema = z.object({ token: z.string().min(20).max(500) });

export const jiraProvider: ConnectorProvider = {
  manifest: {
    providerKey: JIRA_PROVIDER_KEY,
    category: 'work-item',
    displayName: 'Jira',
    description: 'Reads projects and issues from Jira. Acceptance criteria are taken from the description. This connector has been checked against recorded responses, not a live site.',
    authMethods: [{ key: 'api_token', label: 'API token (Jira Cloud also needs the account email)', recommended: true, fields: [{ name: 'token', label: 'API token', secret: true, required: true }] }],
    capabilities: ['workitem.project.list', 'workitem.search', 'workitem.read', 'workitem.attachment.read'],
    requiredPermissions: ['Browse projects and read issues for the token owner.'],
    accessModePolicy: 'read_write',
    requiresInternet: true,
    verification: 'fixtures-only',
    wizard: [
      { key: 'connection', title: 'Site', fields: [{ name: 'baseUrl', label: 'Jira address (https://your-site.atlassian.net)', type: 'url', required: true }, { name: 'email', label: 'Account email (Jira Cloud; leave empty for a bearer token)', type: 'text', required: false }, { name: 'acceptanceCriteriaField', label: 'Acceptance criteria field (leave empty to read them from the description)', type: 'text', required: false }] },
      { key: 'credentials', title: 'API token', fields: [{ name: 'token', label: 'API token', type: 'secret', required: true }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this token can read', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: SecretSchema,
  create(config, secrets, deps) {
    if (!secrets) throw new PlatformError('auth', 'Jira needs an API token');
    return new JiraClient(ConfigSchema.parse(config), SecretSchema.parse(secrets.value).token, deps);
  },
};

class JiraClient implements ConnectorClient {
  private readonly auth: string;

  constructor(
    private readonly cfg: z.infer<typeof ConfigSchema>,
    token: string,
    private readonly deps: AdapterDeps,
  ) {
    this.auth = this.cfg.email ? `Basic ${Buffer.from(`${this.cfg.email}:${token}`).toString('base64')}` : `Bearer ${token}`;
  }

  private async get(path: string, query?: Record<string, string | undefined>) {
    return requestJson(this.deps.http, { method: 'GET', url: joinUrl(this.cfg.baseUrl, path, query), headers: { authorization: this.auth, accept: 'application/json' } }, 'Jira');
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const me = await this.get('/rest/api/3/myself');
      return { ok: true, message: 'Connected to Jira.', latencyMs: Date.now() - started, discovered: { account: me.body?.displayName, acceptanceCriteria: this.cfg.acceptanceCriteriaField ?? 'description' } };
    } catch (e) {
      return { ok: false, message: e instanceof PlatformError ? e.message : 'Could not reach Jira', latencyMs: Date.now() - started };
    }
  }

  async inspectPermissions(): Promise<PermissionReport> {
    await this.get('/rest/api/3/myself');
    return { granted: ['browse', 'read-issues'], writePermissionsDetected: [], notes: ['Issue writes are not used. Acceptance criteria are read from the description unless a field is named.'] };
  }

  async probeCapabilities(): Promise<CapabilityProbeEntry[]> {
    const out: CapabilityProbeEntry[] = [];
    try {
      await this.get('/rest/api/3/project/search', { maxResults: '1' });
      out.push({ capability: 'workitem.project.list', support: 'supported' });
    } catch (e) {
      out.push({ capability: 'workitem.project.list', support: 'unsupported', reason: e instanceof PlatformError ? e.message : 'probe failed' });
    }
    const search = out[0]?.support === 'supported' ? 'supported' : 'unsupported';
    out.push({ capability: 'workitem.search', support: search as 'supported' | 'unsupported' });
    out.push({ capability: 'workitem.read', support: search as 'supported' | 'unsupported', reason: this.cfg.acceptanceCriteriaField ? `Acceptance criteria are read from ${this.cfg.acceptanceCriteriaField}` : 'Acceptance criteria are read from the description' });
    out.push({ capability: 'workitem.attachment.read', support: search as 'supported' | 'unsupported', reason: 'Attachments use the same permission as reading the issue' });
    return out;
  }

  async handle(cap: CapabilityDescriptor, input: unknown): Promise<unknown> {
    const i = (input ?? {}) as Record<string, string>;
    if (cap.id === 'workitem.project.list') {
      const r = await this.get('/rest/api/3/project/search', { maxResults: '50' });
      return { items: ((r.body?.values ?? []) as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name })) };
    }
    if (cap.id === 'workitem.search') {
      const project = i.project ? `project = "${i.project.replace(/"/g, '')}" AND ` : '';
      const r = await this.get('/rest/api/3/search/jql', { jql: `${project}text ~ "${(i.query ?? '').replace(/"/g, '')}"`, maxResults: '20', fields: 'summary,status,issuetype' });
      const issues = (r.body?.issues ?? []) as { key: string; fields?: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } } }[];
      return { items: issues.map((issue) => ({ id: issue.key, title: issue.fields?.summary ?? issue.key, type: issue.fields?.issuetype?.name, state: issue.fields?.status?.name })) };
    }
    if (cap.id === 'workitem.read') {
      const r = await this.get(`/rest/api/3/issue/${encodeURIComponent(required(i.id, 'Issue id'))}`);
      const f = (r.body?.fields ?? {}) as Record<string, unknown>;
      const description = textOf(f.description);
      const acSource = this.cfg.acceptanceCriteriaField ? textOf(f[this.cfg.acceptanceCriteriaField]) : acceptanceCriteriaFromDescription(description);
      return {
        id: r.body?.key ?? i.id,
        title: String(f.summary ?? ''),
        type: (f.issuetype as { name?: string } | undefined)?.name,
        state: (f.status as { name?: string } | undefined)?.name,
        description,
        acceptanceCriteria: acSource,
        url: typeof r.body?.self === 'string' ? undefined : undefined,
      };
    }
    if (cap.id === 'workitem.attachment.read') {
      const issueId = required(i.workItemId ?? i.id, 'Work item');
      const attachmentId = required(i.attachmentId, 'Attachment');
      const issue = await this.get(`/rest/api/3/issue/${encodeURIComponent(issueId)}`, { fields: 'attachment' });
      const files = (issue.body?.fields?.attachment ?? []) as { id?: string; filename?: string; mimeType?: string; content?: string; size?: number }[];
      const file = files.find((a) => a.id === attachmentId || a.filename === attachmentId);
      if (!file?.content) throw new PlatformError('not-found', 'Jira could not find that item');
      if ((file.size ?? 0) > 5_000_000) throw new PlatformError('validation', 'The attachment is larger than 5 MB.');
      const downloaded = await downloadBytes(this.deps.http, file.content, this.auth, 'Jira', new URL(this.cfg.baseUrl));
      return { name: file.filename ?? attachmentId, mimeType: file.mimeType ?? downloaded.mimeType, contentBase64: Buffer.from(downloaded.body).toString('base64') };
    }
    throw new PlatformError('unsupported', `Jira does not implement ${cap.id}`);
  }

  async dispose() {}
}
