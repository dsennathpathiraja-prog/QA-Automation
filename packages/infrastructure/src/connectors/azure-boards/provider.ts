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

/** Fields requested when expand=All still omits System.Title / Description. */
const READ_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.Description',
  'Microsoft.VSTS.TCM.ReproSteps',
  'Microsoft.VSTS.Common.AcceptanceCriteria',
].join(',');

const FIELD_KEYS = ['System.Title', 'System.Description', 'System.State', 'System.WorkItemType'] as const;

/** Turn a WIT fields array `[{ referenceName, value }]` into a map. */
function fieldsFromArray(rows: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as { referenceName?: unknown; name?: unknown; value?: unknown };
    const key = typeof item.referenceName === 'string' ? item.referenceName
      : typeof item.name === 'string' ? item.name
        : '';
    if (key) out[key] = item.value;
  }
  return out;
}

/**
 * Azure WIT returns `{ fields: { 'System.Title': '…' } }` (including `$expand=All`).
 * Some gateways nest again as `{ fields: { fields: { 'System.Title': '…' } } }`,
 * wrap the item as `{ value: { fields } }`, or emit fields as a referenceName array.
 */
export function azureWorkItemFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const root = body as Record<string, unknown>;

  const fromCandidate = (candidate: unknown): Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object') return {};
    if (Array.isArray(candidate)) return fieldsFromArray(candidate);
    const map = candidate as Record<string, unknown>;
    const nested = map.fields;
    if (Array.isArray(nested)) {
      const fromNested = fieldsFromArray(nested);
      if (FIELD_KEYS.some((k) => k in fromNested)) return fromNested;
    }
    if (
      nested
      && typeof nested === 'object'
      && !Array.isArray(nested)
      && FIELD_KEYS.some((k) => k in (nested as object))
    ) {
      return nested as Record<string, unknown>;
    }
    if (FIELD_KEYS.some((k) => k in map)) return map;
    return {};
  };

  const direct = fromCandidate(root.fields);
  if (Object.keys(direct).length > 0) return direct;

  // Batch / list wrappers: `{ value: { fields } }` or `{ value: [ { fields } ] }`.
  const value = root.value;
  if (Array.isArray(value) && value[0]) {
    const fromRow = fromCandidate((value[0] as { fields?: unknown }).fields ?? value[0]);
    if (Object.keys(fromRow).length > 0) return fromRow;
  } else if (value && typeof value === 'object') {
    const fromValue = fromCandidate((value as { fields?: unknown }).fields ?? value);
    if (Object.keys(fromValue).length > 0) return fromValue;
  }

  // Rare: title flattened next to id on the root.
  if (FIELD_KEYS.some((k) => k in root)) return root;
  return {};
}

/** Plain string from a WIT field value (string, number, or `{ value: string }`). */
export function azureFieldString(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key];
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as { value?: unknown; text?: unknown; name?: unknown; html?: unknown };
    if (typeof obj.value === 'string') return obj.value.trim();
    if (typeof obj.text === 'string') return obj.text.trim();
    if (typeof obj.html === 'string') return htmlToText(obj.html).trim();
    if (typeof obj.name === 'string') return obj.name.trim();
  }
  return '';
}

/** Pull System.Title from a WIT body, including nested / wrapped shapes Azure gateways use. */
export function azureWorkItemTitle(body: unknown): string {
  const fields = azureWorkItemFields(body);
  const fromFields = azureFieldString(fields, 'System.Title');
  if (fromFields) return fromFields;
  if (body && typeof body !== 'object') return '';
  // Case-insensitive sweep when a gateway mangles the reference name.
  for (const [k, v] of Object.entries(fields)) {
    if (k.toLowerCase() === 'system.title') {
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as { value?: unknown };
        if (typeof obj.value === 'string' && obj.value.trim()) return obj.value.trim();
      }
    }
  }
  return '';
}

/** Raw HTML (or plain string) from Description / AC / Repro fields. */
export function azureFieldHtml(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key];
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as { html?: unknown; value?: unknown; text?: unknown };
    if (typeof obj.html === 'string') return obj.html.trim();
    if (typeof obj.value === 'string') return obj.value.trim();
    if (typeof obj.text === 'string') return obj.text.trim();
  }
  return textOf(raw).trim();
}

/** Plain text for AC extraction when the field stores HTML. */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return htmlToText(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as { html?: unknown; value?: unknown };
    if (typeof obj.html === 'string') return htmlToText(obj.html);
    if (typeof obj.value === 'string') return htmlToText(obj.value);
  }
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
      // Search is optional for Read story — workitem.read stays supported when WIQL is denied.
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
      const id = required(i.id, 'Work item id');
      const fieldList = READ_FIELDS.includes(acField) ? READ_FIELDS : `${READ_FIELDS},${acField}`;
      // Org-scoped path (no project segment). Matches Dasun’s trafforge curl:
      // GET https://dev.azure.com/{org}/_apis/wit/workitems/{id}?%24expand=All&api-version=7.1
      // Auth stays Basic `:PAT` (browser Cookie from curl paste is not used).
      // `$expand` / `%24expand` are both accepted by ADO; joinUrl emits a literal `$`.
      let r = await this.call('GET', `/_apis/wit/workitems/${encodeURIComponent(id)}`, { $expand: 'All' });
      if (!r.body || typeof r.body !== 'object') {
        throw new PlatformError('transient', 'Azure Boards returned an empty work item payload');
      }
      let f = azureWorkItemFields(r.body);
      let title = azureWorkItemTitle(r.body);
      // When expand=All succeeds but fields are missing/unparsed, request an explicit field list.
      if (!title || !azureFieldHtml(f, 'System.Description')) {
        const listed = await this.call('GET', `/_apis/wit/workitems/${encodeURIComponent(id)}`, { fields: fieldList });
        if (listed.body && typeof listed.body === 'object') {
          const listedFields = azureWorkItemFields(listed.body);
          if (!title) title = azureWorkItemTitle(listed.body);
          if (Object.keys(listedFields).length > 0) {
            f = { ...f, ...listedFields };
            r = listed;
          }
        }
      }
      if (!title) {
        title = await this.titleFromWiql(id);
      }
      const descriptionHtml = azureFieldHtml(f, 'System.Description');
      const reproHtml = azureFieldHtml(f, 'Microsoft.VSTS.TCM.ReproSteps');
      const descriptionText = fieldText(f['System.Description']);
      const reproText = fieldText(f['Microsoft.VSTS.TCM.ReproSteps']);
      const fromField = fieldText(f[acField]);
      const fromDescription = acceptanceCriteriaFromDescription(descriptionText) ?? (scenarioCuesFromDescription(descriptionText).join('\n') || undefined);
      const acceptanceCriteria = fromField || fromDescription || (reproText ? scenarioCuesFromDescription(reproText).join('\n') || reproText : undefined);
      // Keep Description HTML in the story blob (planner still gets AC as plain text).
      const descriptionParts = [
        descriptionHtml,
        reproHtml ? `Repro steps\n${reproHtml}` : '',
      ].filter(Boolean);
      return {
        id: String((r.body as { id?: unknown })?.id ?? i.id),
        title,
        type: azureFieldString(f, 'System.WorkItemType') || undefined,
        state: azureFieldString(f, 'System.State') || undefined,
        description: descriptionParts.join('\n\n') || undefined,
        acceptanceCriteria: acceptanceCriteria || undefined,
        url: typeof (r.body as { _links?: { html?: { href?: unknown } } })?._links?.html?.href === 'string'
          ? (r.body as { _links: { html: { href: string } } })._links.html.href
          : undefined,
      };
    }
    if (cap.id === 'workitem.attachment.read') {
      const id = required(i.workItemId ?? i.id, 'Work item');
      const attachmentId = required(i.attachmentId, 'Attachment');
      const item = await this.call('GET', `/${encodeURIComponent(this.cfg.project)}/_apis/wit/workitems/${encodeURIComponent(id)}`, { $expand: 'relations' });
      const relations = (item.body?.relations ?? []) as { rel?: string; url?: string; attributes?: { name?: string } }[];
      const file = relations.find((rel) => rel.rel === 'AttachedFile' && (rel.url?.includes(attachmentId) || rel.attributes?.name === attachmentId));
      if (!file?.url) throw new PlatformError('not-found', 'Azure Boards could not find that item');
      const downloaded = await downloadBytes(this.deps.http, file.url, this.auth, 'Azure Boards', new URL(this.cfg.baseUrl));
      return { name: file.attributes?.name ?? attachmentId, mimeType: downloaded.mimeType, contentBase64: Buffer.from(downloaded.body).toString('base64') };
    }
    throw new PlatformError('unsupported', `Azure Boards does not implement ${cap.id}`);
  }

  /** WIQL fallback when expand=All / fields still omit System.Title. */
  private async titleFromWiql(id: string): Promise<string> {
    const numeric = Number(id);
    if (!Number.isInteger(numeric) || numeric <= 0) return '';
    try {
      const r = await this.call(
        'POST',
        `/${encodeURIComponent(this.cfg.project)}/_apis/wit/wiql`,
        undefined,
        { query: `SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.Id] = ${numeric}` },
      );
      const ids = ((r.body?.workItems ?? []) as { id: number }[]).map((w) => w.id);
      if (ids.length === 0) return '';
      const details = await this.call(
        'GET',
        `/${encodeURIComponent(this.cfg.project)}/_apis/wit/workitems`,
        { ids: String(ids[0]), fields: 'System.Title' },
      );
      const row = ((details.body?.value ?? []) as unknown[])[0];
      return azureWorkItemTitle(row);
    } catch {
      return '';
    }
  }

  async dispose() {}
}
