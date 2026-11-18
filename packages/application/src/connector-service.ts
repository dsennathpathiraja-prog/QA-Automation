import { randomUUID } from 'node:crypto';
import { PlatformError, matchHost, type Clock, type SecretStore, systemClock } from '@qa/domain';
import type { CapabilityRegistry, ConnectorCategory, ConnectorProvider, PermissionReport, ProviderRegistry } from '@qa/connector-sdk';
import {
  connectorSecretLocator,
  type ApprovedHost,
  type ApprovedHostRepository,
  type AuditSink,
  type CapabilityStateRecord,
  type ConnectorRecord,
  type ConnectorRepository,
  type TestRequestQueue,
  type TestRequestRecord,
} from './ports';

export interface ActorRef {
  id: string;
}

export interface ConnectorServiceDeps {
  connectors: ConnectorRepository;
  tests: TestRequestQueue;
  /** Write-only view on purpose: the API side can store and delete credentials, never read them. */
  secrets: Pick<SecretStore, 'put' | 'exists' | 'delete'>;
  providers: ProviderRegistry;
  capabilities: CapabilityRegistry;
  hosts: ApprovedHostRepository;
  audit: AuditSink;
  clock?: Clock;
}

export interface FieldView {
  name: string;
  label: string;
  type: 'text' | 'url' | 'select' | 'secret';
  required: boolean;
}

export interface ProviderView {
  providerKey: string;
  category: ConnectorCategory;
  displayName: string;
  description: string;
  requiresInternet: boolean;
  requiredPermissions: string[];
  configFields: FieldView[];
  authMethods: { key: string; label: string; recommended: boolean; fields: FieldView[] }[];
  capabilities: { id: string; access: 'read' | 'write' }[];
  steps: { key: string; title: string; action?: string }[];
  verification?: 'live-capable' | 'fixtures-only' | 'built-in';
}

export interface ReadOnlyLayer {
  id: string;
  label: string;
  state: 'holds' | 'blocked' | 'unknown';
  detail: string;
}

export interface ConnectorSummary {
  id: string;
  name: string;
  providerKey: string;
  providerName: string;
  category: ConnectorCategory;
  status: ConnectorRecord['status'];
  enabled: boolean;
  accessMode: ConnectorRecord['accessMode'];
  lastSuccessAt?: string;
  lastTestedAt?: string;
  updatedAt: string;
}

export interface HostIssue {
  host: string;
  reason: 'not-approved' | 'http-not-allowed';
  /** Suggested approval, shown to Administrators. */
  suggestion: { hostPattern: string; internal: boolean; allowHttp: boolean };
}

export interface ConnectorDetail extends ConnectorSummary {
  configVersion: number;
  /** Present only for callers allowed to manage connectors. */
  config?: Record<string, unknown>;
  permissionReport?: PermissionReport;
  discoveredInfo?: Record<string, unknown>;
  hasCredentials: boolean;
  capabilities: { capability: string; access: 'read' | 'write' | 'unknown'; support: CapabilityStateRecord['support']; reason?: string; granted: boolean }[];
  latestTest?: { id: string; status: TestRequestRecord['status']; requestedAt: string; finishedAt?: string; result?: TestRequestRecord['result'] };
  hostIssues: HostIssue[];
  canEnable: boolean;
  readOnlyLayers?: ReadOnlyLayer[];
}

export interface CreateConnectorInput {
  providerKey: string;
  name: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

const SECRET_LIKE_KEY = /(secret|token|password|passwd|api[_-]?key|credential|authorization)/i;
const PRIVATE_NAME = /(^[^.]+$)|\.(local|internal|lan|corp|intranet|home|localdomain)$/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ConnectorService {
  private readonly clock: Clock;

  constructor(private readonly d: ConnectorServiceDeps) {
    this.clock = d.clock ?? systemClock;
  }

  providers(): ProviderView[] {
    return this.d.providers.all().map((p) => this.providerView(p));
  }

  async list(): Promise<ConnectorSummary[]> {
    return (await this.d.connectors.list()).map((c) => this.summary(c));
  }

  async get(id: string, opts: { includeConfig: boolean }): Promise<ConnectorDetail> {
    const rec = await this.require(id);
    const [states, latest, approved] = await Promise.all([this.d.connectors.capabilityStates(id), this.d.tests.latest(id), this.d.hosts.list('connector')]);
    const provider = this.providerOf(rec);
    const secretNeeded = provider ? provider.manifest.authMethods.length > 0 : false;
    const hasCredentials = secretNeeded ? await this.d.secrets.exists(connectorSecretLocator(id)) : false;
    const declared = new Set<string>(provider?.manifest.capabilities ?? []);
    const caps = new Map(states.map((s) => [s.capability, s]));
    const access = (cap: string): 'read' | 'write' | 'unknown' => (this.d.capabilities.has(cap) ? this.d.capabilities.get(cap).access : 'unknown');
    const capabilities = [...declared].sort().map((cap) => {
      const s = caps.get(cap);
      return { capability: cap, access: access(cap), support: s?.support ?? ('unsupported' as const), reason: s?.reason ?? (s ? undefined : 'Not tested yet'), granted: s?.granted ?? false };
    });
    return {
      ...this.summary(rec),
      configVersion: rec.configVersion,
      config: opts.includeConfig ? rec.config : undefined,
      permissionReport: rec.permissionReport,
      discoveredInfo: rec.discoveredInfo,
      hasCredentials,
      capabilities,
      latestTest: latest && { id: latest.id, status: latest.status, requestedAt: latest.requestedAt.toISOString(), finishedAt: latest.finishedAt?.toISOString(), result: latest.result },
      hostIssues: provider ? this.hostIssues(provider, rec.config, approved) : [],
      canEnable: !rec.enabled && (rec.status === 'connected' || rec.status === 'degraded'),
      readOnlyLayers: provider?.manifest.category === 'source-repo' ? this.readOnlyLayers(rec, provider, provider ? this.hostIssues(provider, rec.config, approved) : []) : undefined,
    };
  }

  async create(actor: ActorRef, input: CreateConnectorInput): Promise<ConnectorDetail> {
    const provider = this.d.providers.get(input.providerKey);
    const name = this.validName(input.name);
    const config = this.parseConfig(provider, input.config ?? {});
    const secrets = this.parseSecrets(provider, input.secrets);
    const id = randomUUID();
    if (secrets) await this.d.secrets.put(connectorSecretLocator(id), secrets);
    try {
      await this.d.connectors.insert({ id, providerKey: provider.manifest.providerKey, category: provider.manifest.category, name, config, accessMode: this.accessModeFor(provider) });
    } catch (e) {
      if (secrets) await this.d.secrets.delete(connectorSecretLocator(id)).catch(() => undefined);
      throw e;
    }
    await this.d.audit.append({
      actorId: actor.id,
      action: 'connector.create',
      subjectType: 'connector',
      subjectId: id,
      detail: { providerKey: provider.manifest.providerKey, name, accessMode: 'read_only', credentialsStored: !!secrets },
    });
    return this.get(id, { includeConfig: true });
  }

  async update(actor: ActorRef, id: string, patch: { name?: string; config?: Record<string, unknown> }): Promise<ConnectorDetail> {
    const rec = await this.require(id);
    this.assertNotDisconnected(rec);
    const provider = this.d.providers.get(rec.providerKey);
    const changes: Record<string, unknown> = {};
    const update: Parameters<ConnectorRepository['update']>[1] = {};
    if (patch.name !== undefined) {
      update.name = this.validName(patch.name);
      changes.name = true;
    }
    if (patch.config !== undefined) {
      const config = this.parseConfig(provider, patch.config);
      if (!same(config, rec.config)) {
        update.config = config;
        update.configVersion = rec.configVersion + 1;
        update.status = 'draft';
        update.enabled = false;
        changes.config = Object.keys(config).filter((k) => !same(config[k], rec.config[k]));
      }
    }
    if (Object.keys(update).length > 0) await this.d.connectors.update(id, update);
    if (Object.keys(changes).length > 0) {
      await this.d.audit.append({ actorId: actor.id, action: 'connector.update', subjectType: 'connector', subjectId: id, detail: { changed: changes, retestRequired: update.status === 'draft' } });
    }
    return this.get(id, { includeConfig: true });
  }

  async replaceCredentials(actor: ActorRef, id: string, secrets: Record<string, unknown>): Promise<ConnectorDetail> {
    const rec = await this.require(id);
    const provider = this.d.providers.get(rec.providerKey);
    const parsed = this.parseSecrets(provider, secrets);
    if (!parsed) throw new PlatformError('validation', 'This connector does not use credentials');
    const { version } = await this.d.secrets.put(connectorSecretLocator(id), parsed);
    await this.d.connectors.update(id, { status: 'draft', enabled: false, configVersion: rec.configVersion + 1 });
    await this.d.audit.append({ actorId: actor.id, action: 'connector.credentials.replace', subjectType: 'connector', subjectId: id, detail: { secretVersion: version, retestRequired: true } });
    return this.get(id, { includeConfig: true });
  }

  async requestTest(actor: ActorRef, id: string): Promise<TestRequestRecord> {
    const rec = await this.require(id);
    this.assertNotDisconnected(rec);
    const provider = this.d.providers.get(rec.providerKey);
    if (provider.manifest.authMethods.length > 0 && !(await this.d.secrets.exists(connectorSecretLocator(id)))) {
      throw new PlatformError('validation', 'No credentials are stored for this connector. Add them first.');
    }
    const req = await this.d.tests.enqueue(id, rec.configVersion, actor.id);
    await this.d.audit.append({ actorId: actor.id, action: 'connector.test.request', subjectType: 'connector', subjectId: id, detail: { requestId: req.id } });
    return req;
  }

  async enable(actor: ActorRef, id: string): Promise<ConnectorDetail> {
    const rec = await this.require(id);
    if (rec.status !== 'connected' && rec.status !== 'degraded') {
      throw new PlatformError('conflict', 'Run a successful Test Connection before enabling this connector.');
    }
    if (!rec.enabled) {
      await this.d.connectors.update(id, { enabled: true });
      await this.d.audit.append({ actorId: actor.id, action: 'connector.enable', subjectType: 'connector', subjectId: id });
    }
    return this.get(id, { includeConfig: true });
  }

  async disable(actor: ActorRef, id: string): Promise<ConnectorDetail> {
    const rec = await this.require(id);
    if (rec.enabled) {
      await this.d.connectors.update(id, { enabled: false });
      await this.d.audit.append({ actorId: actor.id, action: 'connector.disable', subjectType: 'connector', subjectId: id });
    }
    return this.get(id, { includeConfig: true });
  }

  /** Stops the connector and deletes its stored credentials. The record and its history stay. */
  async disconnect(actor: ActorRef, id: string): Promise<ConnectorDetail> {
    const rec = await this.require(id);
    if (rec.status !== 'disconnected') {
      await this.d.connectors.update(id, { enabled: false, status: 'disconnected', configVersion: rec.configVersion + 1 });
      await this.d.secrets.delete(connectorSecretLocator(id));
      await this.d.audit.append({ actorId: actor.id, action: 'connector.disconnect', subjectType: 'connector', subjectId: id, detail: { credentialsDeleted: true } });
    }
    return this.get(id, { includeConfig: true });
  }

  /** Only drafts and disconnected connectors can be removed. */
  async remove(actor: ActorRef, id: string): Promise<void> {
    const rec = await this.require(id);
    if (rec.status !== 'draft' && rec.status !== 'disconnected') {
      throw new PlatformError('conflict', 'Disconnect this connector before removing it.');
    }
    await this.d.secrets.delete(connectorSecretLocator(id));
    await this.d.connectors.softDelete(id);
    await this.d.audit.append({ actorId: actor.id, action: 'connector.delete', subjectType: 'connector', subjectId: id, detail: { name: rec.name } });
  }

  async approveHost(actor: ActorRef, h: { hostPattern: string; purpose?: 'connector' | 'application'; internal: boolean; allowHttp: boolean }): Promise<ApprovedHost> {
    const pattern = h.hostPattern.trim().toLowerCase();
    if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(pattern)) throw new PlatformError('validation', 'Host must be a name such as example.com or *.example.com (no scheme, port or path).');
    if (pattern === '*' || pattern.startsWith('*.') && pattern.split('.').length < 3) throw new PlatformError('validation', 'Wildcards must name a domain, such as *.example.com.');
    if (h.allowHttp && !h.internal) throw new PlatformError('validation', 'Plain http is only allowed for internal hosts.');
    const purpose = h.purpose ?? 'connector';
    const added = await this.d.hosts.add({ hostPattern: pattern, purpose, internal: h.internal, allowHttp: h.allowHttp, approvedBy: actor.id });
    await this.d.audit.append({ actorId: actor.id, action: 'egress.host.approve', subjectType: 'egress_host', subjectId: added.id, detail: { hostPattern: pattern, purpose, internal: h.internal, allowHttp: h.allowHttp } });
    return added;
  }

  async removeHost(actor: ActorRef, id: string): Promise<void> {
    const removed = await this.d.hosts.remove(id);
    if (!removed) throw new PlatformError('not-found', 'Approved host not found');
    await this.d.audit.append({ actorId: actor.id, action: 'egress.host.remove', subjectType: 'egress_host', subjectId: id, detail: { hostPattern: removed.hostPattern } });
  }

  async listHosts(): Promise<ApprovedHost[]> {
    const [connectors, applications] = await Promise.all([this.d.hosts.list('connector'), this.d.hosts.list('application')]);
    return [...connectors, ...applications].sort((a, b) => a.hostPattern.localeCompare(b.hostPattern) || a.purpose.localeCompare(b.purpose));
  }

  private summary(c: ConnectorRecord): ConnectorSummary {
    const p = this.providerOf(c);
    return {
      id: c.id,
      name: c.name,
      providerKey: c.providerKey,
      providerName: p?.manifest.displayName ?? c.providerKey,
      category: c.category,
      status: c.status,
      enabled: c.enabled,
      accessMode: c.accessMode,
      lastSuccessAt: c.lastSuccessAt?.toISOString(),
      lastTestedAt: c.lastTestedAt?.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  private providerOf(c: ConnectorRecord): ConnectorProvider | undefined {
    try {
      return this.d.providers.get(c.providerKey);
    } catch {
      return undefined;
    }
  }

  private providerView(p: ConnectorProvider): ProviderView {
    const m = p.manifest;
    const configFields: FieldView[] = [];
    for (const step of m.wizard) {
      for (const f of step.fields ?? []) {
        if (f.type !== 'secret') configFields.push({ name: f.name, label: f.label, type: f.type, required: f.required });
      }
    }
    return {
      providerKey: m.providerKey,
      category: m.category,
      displayName: m.displayName,
      description: m.description,
      requiresInternet: m.requiresInternet,
      requiredPermissions: m.requiredPermissions,
      configFields,
      authMethods: m.authMethods.map((a) => ({
        key: a.key,
        label: a.label,
        recommended: !!a.recommended,
        fields: a.fields.map((f) => ({ name: f.name, label: f.label, type: 'secret' as const, required: f.required })),
      })),
      capabilities: m.capabilities.map((id) => ({ id, access: this.d.capabilities.has(id) ? this.d.capabilities.get(id).access : 'read' })),
      steps: m.wizard.map((s) => ({ key: s.key, title: s.title, action: s.action })),
      verification: m.verification,
    };
  }

  private hostIssues(p: ConnectorProvider, config: Record<string, unknown>, approved: ApprovedHost[]): HostIssue[] {
    const issues: HostIssue[] = [];
    for (const step of p.manifest.wizard) {
      for (const f of step.fields ?? []) {
        if (f.type !== 'url') continue;
        const raw = config[f.name];
        if (typeof raw !== 'string') continue;
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          continue;
        }
        const host = url.hostname.toLowerCase();
        const rule = approved.find((a) => matchHost(a.hostPattern, host));
        const likelyInternal = PRIVATE_NAME.test(host) || PRIVATE_IP.test(host);
        const suggestion = { hostPattern: host, internal: likelyInternal, allowHttp: likelyInternal && url.protocol === 'http:' };
        if (!rule) issues.push({ host, reason: 'not-approved', suggestion });
        else if (url.protocol === 'http:' && !(rule.internal && rule.allowHttp)) issues.push({ host, reason: 'http-not-allowed', suggestion: { ...suggestion, hostPattern: rule.hostPattern, internal: rule.internal } });
      }
    }
    return issues;
  }

  /** Source repositories are always read-only. The current Squash is also created read-only (D20). A writable Squash is a separate, explicitly enabled connector. A browser connector may drive the page, which the catalog calls a write. */
  private accessModeFor(p: ConnectorProvider): 'read_only' | 'read_write' {
    if (p.manifest.category === 'browser-automation') return 'read_write';
    return 'read_only';
  }

  private readOnlyLayers(rec: ConnectorRecord, p: ConnectorProvider, hostIssues: HostIssue[]): ReadOnlyLayer[] | undefined {
    if (rec.category !== 'source-repo') return undefined;
    const writes = p.manifest.capabilities.filter((id) => this.d.capabilities.has(id) && this.d.capabilities.get(id).access === 'write');
    const report = rec.permissionReport;
    const credential: ReadOnlyLayer['state'] = !report ? 'unknown' : report.writePermissionsDetected.length > 0 ? 'blocked' : 'holds';
    return [
      { id: 'access-mode', label: 'The connection is read-only', state: rec.accessMode === 'read_only' ? 'holds' : 'blocked', detail: 'Source repositories are stored as read-only and the database refuses anything else.' },
      { id: 'catalog', label: 'There is no write action for a source repository', state: writes.length === 0 ? 'holds' : 'blocked', detail: 'The platform has no capability that commits, pushes or edits repository files.' },
      { id: 'http', label: 'Only read requests are sent', state: 'holds', detail: 'This connector is allowed to send GET requests. A write request is refused before it leaves the platform.' },
      {
        id: 'credential',
        label: 'The token has no write permission',
        state: credential,
        detail: !report ? 'Run Test connection to inspect the token.' : credential === 'blocked' ? `Write permission found: ${report.writePermissionsDetected.join(', ')}. Replace it with a read-only token before switching this connector on.` : 'No write permission was found on this token.',
      },
      { id: 'host', label: 'The host is approved', state: hostIssues.length === 0 ? 'holds' : 'blocked', detail: hostIssues.length === 0 ? 'The address is on the approved-host list.' : 'Approve the host before this connector can connect.' },
      { id: 'git', label: 'The platform cannot write git', state: 'holds', detail: 'No git write library is part of this build. Generated tests stay in a platform workspace, never in the connected repository.' },
    ];
  }

  private validName(raw: string): string {
    const name = (raw ?? '').trim();
    if (name.length < 3 || name.length > 80) throw new PlatformError('validation', 'Name must be 3 to 80 characters.');
    return name;
  }

  private parseConfig(p: ConnectorProvider, raw: Record<string, unknown>): Record<string, unknown> {
    for (const k of Object.keys(raw)) {
      if (SECRET_LIKE_KEY.test(k)) throw new PlatformError('validation', `"${k}" looks like a credential. Enter credentials in the credentials fields, not in settings.`);
    }
    const r = p.configSchema.safeParse(raw);
    if (!r.success) throw new PlatformError('validation', r.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; '));
    return r.data as Record<string, unknown>;
  }

  private parseSecrets(p: ConnectorProvider, raw: Record<string, unknown> | undefined): Record<string, string> | undefined {
    if (p.manifest.authMethods.length === 0) return undefined;
    if (!raw || Object.keys(raw).length === 0) throw new PlatformError('validation', 'Credentials are required for this connector.');
    const r = p.secretSchema.safeParse(raw);
    if (!r.success) {
      // Field names only: the submitted values must never be echoed back.
      throw new PlatformError('validation', `Credentials are not valid: ${r.error.issues.map((i) => i.path.join('.') || 'credentials').join(', ')}`);
    }
    return r.data as Record<string, string>;
  }

  private assertNotDisconnected(rec: ConnectorRecord) {
    if (rec.status === 'disconnected') throw new PlatformError('conflict', 'This connector is disconnected. Replace its credentials to reconnect.');
  }

  private async require(id: string): Promise<ConnectorRecord> {
    const rec = await this.d.connectors.get(id);
    if (!rec) throw new PlatformError('not-found', 'Connector not found');
    return rec;
  }
}
