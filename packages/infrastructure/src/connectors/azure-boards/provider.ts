import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { AdapterDeps, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { acceptanceCriteriaFromDescription, scenarioCuesFromDescription, textOf } from '../acceptance-criteria';
import { downloadBytes, joinUrl, requestJson, required } from '../rest';
import { htmlToText } from '../squash/html';

export const AZURE_BOARDS_PROVIDER_KEY = 'azure-boards';

const ConfigSchema = z.object({
  organization: z.string().min(1).max(100),
  project: z.string().min(1).max(100),
  baseUrl: z.string().url().optional(),
  acceptanceCriteriaField: z.string().min(1).max(200).default('Microsoft.VSTS.Common.AcceptanceCriteria'),
});
const SecretSchema = z.object({ token: z.string().min(20).max(500) });
const API = '7.1';

/** Fields requested on workitem.read so System.Title is always present in the payload. */
const READ_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.Description',
  'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
].join(',');

/**
 * Azure WIT returns `{ fields: { 'System.Title': '…' } }`.
 * Some gateways nest again as `{ fields: { fields: { 'System.Title': '…' } } }`.
 */
export function azureWorkItemFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const root = body as Record<string, unknown>;
  const outer = root.fields;
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) return {};
  const map = outer as Record<string, unknown>;
  const nested = map.fields;
  if (
    nested
    && typeof nested === 'object'
    && !Array.isArray(nested)
    && ('System.Title' in (nested as object) || 'System.Description' in (nested as object))
  ) {
    return nested as Record<string, unknown>;
  }
  return map;
}

/** Plain string from a WIT field value (string or `{ value: string }`). */
export function azureFieldString(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key];
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && typeof (raw as { value?: unknown }).value === 'string') {
    return ((raw as { value: string }).value).trim();
  }
  return '';
}

/** Azure Boards stores Description, Acceptance Criteria, and Repro Steps as HTML. */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return htmlToText(value);
  return htmlToText(textOf(value));
}

export const azureBoardsProvider: ConnectorProvider = {
  manifest: {
    providerKey: AZURE_BOARDS_PROVIDER_KEY,
    category: 'work-item',
    displayName: 'Azure Boards',
    description: 'Reads projects and work items from Azure Boards. Acceptance criteria come from the Acceptance Criteria field, or from the Description when that field is empty.',
    authMethods: [{ key: 'pat', label: 'Personal access token with Work Items (Read)', recommended: true, fields: [{ name: 'token', label: 'Access token', secret: true, required: true }] }],
    capabilities: ['workitem.project.list', 'workitem.search', 'workitem.read', 'workitem.attachment.read'],
    requiredPermissions: ['Work Items (Read) on the organisation.'],
    accessModePolicy: 'read_write',
    requiresInternet: true,
    verification: 'live-capable',
    wizard: [
      { key: 'connection', title: 'Project', fields: [{ name: 'organization', label: 'Organisation', type: 'text', required: true }, { name: 'project', label: 'Project', type: 'text', required: true }, { name: 'baseUrl', label: 'Address (leave empty for https://dev.azure.com)', type: 'url', required: false }, { name: 'acceptanceCriteriaField', label: 'Acceptance criteria field', type: 'text', required: false }] },
      { key: 'credentials', title: 'Access token', fields: [{ name: 'token', label: 'Access token', type: 'secret', required: true }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this token can read', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: SecretSchema,
  create(config, secrets, deps) {
    if (!secrets) throw new PlatformError('auth', 'Azure Boards needs an access token');
    const cfg = ConfigSchema.parse(config);
    return new AzureBoardsClient({ ...cfg, baseUrl: cfg.baseUrl ?? `https://dev.azure.com/${cfg.organization}` }, SecretSchema.parse(secrets.value).token, deps);
  },
};

class AzureBoardsClient implements ConnectorClient {
  private readonly auth: string;

  constructor(
    private readonly cfg: z.infer<typeof ConfigSchema> & { baseUrl: string },
    token: string,
    private readonly deps: AdapterDeps,
  ) {
    this.auth = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  }

  private async call(method: 'GET' | 'POST', path: string, query?: Record<string, string | undefined>, body?: unknown) {
    return requestJson(
      this.deps.http,
      { method, url: joinUrl(this.cfg.baseUrl, path, { 'api-version': API, ...query }), headers: { authorization: this.auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
      'Azure Boards',
    );
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const projects = await this.call('GET', '/_apis/projects', { $top: '1' });
      return { ok: true, message: 'Connected to Azure Boards.', latencyMs: Date.now() - started, discovered: { organization: this.cfg.organization, project: this.cfg.project, projectsVisible: projects.body?.count, acceptanceCriteriaField: this.cfg.acceptanceCriteriaField } };
    } catch (e) {
      return { ok: false, message: e instanceof PlatformError ? e.message : 'Could not reach Azure Boards', latencyMs: Date.now() - started };
    }
  }

  async inspectPermissions(): Promise<PermissionReport> {
    await this.call('GET', '/_apis/projects', { $top: '1' });
    return { granted: ['work-items.read'], writePermissionsDetected: [], notes: ['Work item writes are not used.'] };
  }

  async probeCapabilities(): Promise<CapabilityProbeEntry[]> {
    try {
      await this.call('GET', '/_apis/projects', { $top: '1' });
    } catch (e) {
      const reason = e instanceof PlatformError ? e.message : 'probe failed';
      return ['workitem.project.list', 'workitem.search', 'workitem.read', 'workitem.attachment.read'].map((capability) => ({ capability, support: 'unsupported' as const, reason }));
    }
    let search: CapabilityProbeEntry = { capability: 'workitem.search', support: 'supported' };
    try {
      await this.call('POST', `/${encodeURIComponent(this.cfg.project)}/_apis/wit/wiql`, undefined, { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${this.cfg.project.replace(/'/g, "''")}'` });
    } catch (e) {
      search = { capability: 'workitem.search', support: 'unsupported', reason: e instanceof PlatformError ? e.message : 'probe failed' };
    }
    return [
      { capability: 'workitem.project.list', support: 'supported' },
      search,
      { capability: 'workitem.read', support: 'supported', reason: `Acceptance criteria are read from ${this.cfg.acceptanceCriteriaField}, or from the Description when that field is empty` },
      { capability: 'workitem.attachment.read', support: 'supported', reason: 'Attachments use the same permission as reading the work item' },
    ];
  }

  async handle(cap: CapabilityDescriptor, input: unknown): Promise<unknown> {
    const i = (input ?? {}) as Record<string, string>;
    if (cap.id === 'workitem.project.list') {
      const r = await this.call('GET', '/_apis/projects');
      return { items: ((r.body?.value ?? []) as { id: string; name: string }[]).map((p) => ({ id: p.id, name: p.name })) };
    }
    if (cap.id === 'workitem.search') {
      const project = (i.project ?? this.cfg.project).replace(/'/g, "''");
      const text = (i.query ?? '').replace(/'/g, "''");
      const r = await this.call('POST', `/${encodeURIComponent(this.cfg.project)}/_apis/wit/wiql`, undefined, { query: `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Title] CONTAINS '${text}'` });
      const ids = ((r.body?.workItems ?? []) as { id: number }[]).map((w) => w.id);
      if (ids.length === 0) return { items: [] };
      const details = await this.call('GET', `/${encodeURIComponent(this.cfg.project)}/_apis/wit/workitems`, { ids: ids.slice(0, 20).join(','), fields: 'System.Title,System.State,System.WorkItemType' });
      return { items: ((details.body?.value ?? []) as { id: number; fields: Record<string, string> }[]).map((w) => ({ id: String(w.id), title: w.fields['System.Title'], type: w.fields['System.WorkItemType'], state: w.fields['System.State'] })) };
    }
    if (cap.id === 'workitem.read') {
      const acField = this.cfg.acceptanceCriteriaField;
      const fieldList = READ_FIELDS.includes(acField) ? READ_FIELDS : `${READ_FIELDS},${acField}`;
      const r = await this.call(
        'GET',
        `/${encodeURIComponent(this.cfg.project)}/_apis/wit/workitems/${encodeURIComponent(required(i.id, 'Work item id'))}`,
        { fields: fieldList },
      );
      const f = azureWorkItemFields(r.body);
      const title = azureFieldString(f, 'System.Title');
      const description = fieldText(f['System.Description']);
      const reproSteps = fieldText(f['Microsoft.VSTS.TCM.ReproSteps']);
      const fromField = fieldText(f[acField]);
      const fromDescription = acceptanceCriteriaFromDescription(description) ?? (scenarioCuesFromDescription(description).join('\n') || undefined);
      const acceptanceCriteria = fromField || fromDescription || (reproSteps ? scenarioCuesFromDescription(reproSteps).join('\n') || reproSteps : undefined);
      const descriptionParts = [description, reproSteps ? `Repro steps\n${reproSteps}` : ''].filter(Boolean);
      return {
        id: String(r.body?.id ?? i.id),
        title,
        type: azureFieldString(f, 'System.WorkItemType') || undefined,
        state: azureFieldString(f, 'System.State') || undefined,
        description: descriptionParts.join('\n\n') || undefined,
        acceptanceCriteria: acceptanceCriteria || undefined,
        url: typeof r.body?._links?.html?.href === 'string' ? r.body._links.html.href : undefined,
      };
    }
    if (cap.id === 'workitem.attachment.read') {
      const id = required(i.workItemId ?? i.id, 'Work item');
      const attachmentId = required(i.attachmentId, 'Attachment');
      const item = await this.call('GET', `/${encodeURIComponent(this.cfg.project)}/_apis/wit/workitems/${encodeURIComponent(id)}`, { $expand: 'relations' });
      const relations = (item.body?.relations ?? []) as { rel?: string; url?: string; attributes?: { name?: string } }[];
      const file = relations.find((r) => r.rel === 'AttachedFile' && (r.url?.includes(attachmentId) || r.attributes?.name === attachmentId));
      if (!file?.url) throw new PlatformError('not-found', 'Azure Boards could not find that item');
      const downloaded = await downloadBytes(this.deps.http, file.url, this.auth, 'Azure Boards', new URL(this.cfg.baseUrl));
      return { name: file.attributes?.name ?? attachmentId, mimeType: downloaded.mimeType, contentBase64: Buffer.from(downloaded.body).toString('base64') };
    }
    throw new PlatformError('unsupported', `Azure Boards does not implement ${cap.id}`);
  }

  async dispose() {}
}
