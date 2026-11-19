import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlatformError, type SecretStore } from '@qa/domain';
import type { ActorRef } from './connector-service';
import { EnvironmentConfig, type EnvironmentValidation, type ResolvedEnvironment } from './environment-config';
import { checkedApplicationUrl } from './environment-rules';
import {
  ENVIRONMENT_KINDS,
  type ApprovedHost,
  type ApprovedHostRepository,
  type AuditSink,
  type ConnectorLookup,
  type EnvironmentAuthorizationRecord,
  type EnvironmentBrowser,
  type EnvironmentKind,
  type EnvironmentRecord,
  type EnvironmentRepository,
  type EnvironmentRestrictions,
  type SecretRefWrite,
  type UserDirectory,
} from './ports';

const BrowserSchema = z
  .object({
    browser: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
    viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).optional(),
    headless: z.boolean().default(true),
    locale: z.string().min(2).max(20).optional(),
  })
  .strict();

const RestrictionsSchema = z
  .object({
    workflowTypes: z.array(z.enum(['requirement-validation', 'regression-testing'])).max(2).optional(),
    maxParallelism: z.number().int().min(1).max(50).default(1),
    prodSafeOnly: z.boolean().default(false),
  })
  .strict();

export interface EnvironmentSummary {
  id: string;
  name: string;
  kind: EnvironmentKind;
  applicationUrl: string;
  enabled: boolean;
  /** False for production until an authorization is active, and for any disabled environment. */
  selectable: boolean;
  authorizationUntil?: string;
}

export interface EnvironmentDetail extends EnvironmentSummary {
  browser: EnvironmentBrowser;
  restrictions: EnvironmentRestrictions;
  reachability: EnvironmentRecord['reachability'];
  reachabilityDetail?: string;
  reachabilityCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEnvironmentInput {
  name: string;
  kind: EnvironmentKind;
  applicationUrl: string;
  browser?: Partial<EnvironmentBrowser>;
  restrictions?: Partial<EnvironmentRestrictions>;
  enabled?: boolean;
}

export interface UpdateEnvironmentInput {
  name?: string;
  kind?: EnvironmentKind;
  applicationUrl?: string;
  browser?: Partial<EnvironmentBrowser>;
  restrictions?: Partial<EnvironmentRestrictions>;
  enabled?: boolean;
}

export class EnvironmentService {
  private readonly config: EnvironmentConfig;

  constructor(
    private readonly d: {
      environments: EnvironmentRepository;
      hosts: ApprovedHostRepository;
      audit: AuditSink;
      secrets?: Pick<SecretStore, 'put' | 'exists' | 'delete'>;
      secretStoreKind?: SecretRefWrite['store'];
      users?: UserDirectory;
      connectors?: ConnectorLookup;
    },
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {
    this.config = new EnvironmentConfig(d, this.clock);
  }

  async list(): Promise<EnvironmentSummary[]> {
    const rows = await this.d.environments.list();
    const out: EnvironmentSummary[] = [];
    for (const row of rows) out.push(await this.summary(row));
    return out;
  }

  async get(id: string): Promise<EnvironmentDetail> {
    const row = await this.require(id);
    return {
      ...(await this.summary(row)),
      browser: row.browser,
      restrictions: row.restrictions,
      reachability: row.reachability,
      reachabilityDetail: row.reachabilityDetail,
      reachabilityCheckedAt: row.reachabilityCheckedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(actor: ActorRef, input: CreateEnvironmentInput): Promise<EnvironmentDetail> {
    const kind = this.kind(input.kind);
    const applicationUrl = this.applicationUrl(input.applicationUrl, await this.d.hosts.list('application'));
    const browser = this.browser(input.browser);
    const restrictions = this.restrictions(kind, input.restrictions);
    const rec = await this.d.environments.insert({
      id: randomUUID(),
      name: this.name(input.name),
      kind,
      applicationUrl,
      browser,
      restrictions,
      enabled: input.enabled !== false,
      createdBy: actor.id,
    });
    await this.d.audit.append({ actorId: actor.id, action: 'environment.create', subjectType: 'environment', subjectId: rec.id, detail: { name: rec.name, kind: rec.kind } });
    return this.get(rec.id);
  }

  async update(actor: ActorRef, id: string, input: UpdateEnvironmentInput): Promise<EnvironmentDetail> {
    const current = await this.require(id);
    const kind = input.kind === undefined ? current.kind : this.kind(input.kind);
    const hosts = await this.d.hosts.list('application');
    const applicationUrl = input.applicationUrl === undefined ? current.applicationUrl : this.applicationUrl(input.applicationUrl, hosts);
    const browser = input.browser === undefined ? current.browser : this.browser({ ...current.browser, ...input.browser });
    const restrictions = input.restrictions === undefined && input.kind === undefined ? current.restrictions : this.restrictions(kind, { ...current.restrictions, ...input.restrictions });
    await this.d.environments.update(id, {
      name: input.name === undefined ? undefined : this.name(input.name),
      kind,
      applicationUrl,
      browser,
      restrictions,
      enabled: input.enabled,
    });
    if (applicationUrl !== current.applicationUrl) await this.d.environments.clearReachability(id);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.update', subjectType: 'environment', subjectId: id, detail: { name: input.name ?? current.name, kind } });
    return this.get(id);
  }

  async requestReachability(actor: ActorRef, id: string): Promise<EnvironmentDetail> {
    const row = await this.require(id);
    if (!row.enabled) throw new PlatformError('conflict', 'Enable this environment before checking it.');
    await this.d.environments.queueReachability(id);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.reachability.request', subjectType: 'environment', subjectId: id });
    return this.get(id);
  }

  async disable(actor: ActorRef, id: string): Promise<EnvironmentDetail> {
    await this.require(id);
    await this.d.environments.update(id, { enabled: false });
    await this.d.audit.append({ actorId: actor.id, action: 'environment.disable', subjectType: 'environment', subjectId: id });
    return this.get(id);
  }

  async enable(actor: ActorRef, id: string): Promise<EnvironmentDetail> {
    await this.require(id);
    await this.d.environments.update(id, { enabled: true });
    await this.d.audit.append({ actorId: actor.id, action: 'environment.enable', subjectType: 'environment', subjectId: id });
    return this.get(id);
  }

  async remove(actor: ActorRef, id: string): Promise<void> {
    const rec = await this.require(id);
    if (rec.enabled) throw new PlatformError('conflict', 'Disable this environment before removing it.');
    await this.d.environments.softDelete(id);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.delete', subjectType: 'environment', subjectId: id, detail: { name: rec.name } });
  }

  private async summary(row: EnvironmentRecord): Promise<EnvironmentSummary> {
    const auth = row.kind === 'production' ? await this.d.environments.activeAuthorization(row.id, this.clock.now()) : undefined;
    const selectable = row.enabled && (row.kind !== 'production' || this.authorizationHolds(auth));
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      applicationUrl: row.applicationUrl,
      enabled: row.enabled,
      selectable,
      authorizationUntil: auth && this.authorizationHolds(auth) ? auth.validUntil.toISOString() : undefined,
    };
  }

  private authorizationHolds(auth: EnvironmentAuthorizationRecord | undefined): boolean {
    if (!auth || auth.status !== 'active') return false;
    const now = this.clock.now();
    return auth.validFrom <= now && auth.validUntil > now;
  }

  private async require(id: string): Promise<EnvironmentRecord> {
    const row = await this.d.environments.get(id);
    if (!row) throw new PlatformError('not-found', 'Environment not found');
    return row;
  }

  private name(raw: string): string {
    const name = raw.trim();
    if (name.length < 1 || name.length > 120) throw new PlatformError('validation', 'Name must be between 1 and 120 characters.');
    return name;
  }

  private kind(raw: string): EnvironmentKind {
    if (!(ENVIRONMENT_KINDS as readonly string[]).includes(raw)) throw new PlatformError('validation', 'Kind must be development, qa, staging, uat, or production.');
    return raw as EnvironmentKind;
  }

  private browser(raw: Partial<EnvironmentBrowser> | undefined): EnvironmentBrowser {
    const parsed = BrowserSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new PlatformError('validation', 'Browser settings are not valid. Use chromium, firefox, or webkit, and a viewport between 320 and 3840 pixels.');
    return parsed.data;
  }

  private restrictions(kind: EnvironmentKind, raw: Partial<EnvironmentRestrictions> | undefined): EnvironmentRestrictions {
    const parsed = RestrictionsSchema.safeParse(raw ?? {});
    if (!parsed.success) throw new PlatformError('validation', 'Execution restrictions are not valid. Parallelism must be from 1 to 50.');
    if (kind === 'production' && parsed.data.prodSafeOnly !== true) {
      throw new PlatformError('validation', 'Production runs only cases marked prod-safe. Set that restriction before saving a production environment.');
    }
    return parsed.data;
  }

  listAuthProfiles(environmentId: string) {
    return this.config.listAuthProfiles(environmentId);
  }
  createAuthProfile(actor: ActorRef, environmentId: string, input: { name: string; type: string; config?: Record<string, string>; secrets?: Record<string, string> }) {
    return this.config.createAuthProfile(actor, environmentId, input);
  }
  updateAuthProfile(actor: ActorRef, environmentId: string, id: string, input: { name?: string; type?: string; config?: Record<string, string>; secrets?: Record<string, string> }) {
    return this.config.updateAuthProfile(actor, environmentId, id, input);
  }
  deleteAuthProfile(actor: ActorRef, environmentId: string, id: string) {
    return this.config.deleteAuthProfile(actor, environmentId, id);
  }
  listTestData(environmentId: string) {
    return this.config.listTestData(environmentId);
  }
  createTestData(actor: ActorRef, environmentId: string, input: { name: string; data?: Record<string, string>; secrets?: Record<string, string> }) {
    return this.config.createTestData(actor, environmentId, input);
  }
  updateTestData(actor: ActorRef, environmentId: string, id: string, input: { name?: string; data?: Record<string, string>; secrets?: Record<string, string> }) {
    return this.config.updateTestData(actor, environmentId, id, input);
  }
  deleteTestData(actor: ActorRef, environmentId: string, id: string) {
    return this.config.deleteTestData(actor, environmentId, id);
  }
  listConnectorRefs(environmentId: string) {
    return this.config.listConnectorRefs(environmentId);
  }
  setConnectorRef(actor: ActorRef, environmentId: string, input: { role: string; connectorId: string }) {
    return this.config.setConnectorRef(actor, environmentId, input);
  }
  removeConnectorRef(actor: ActorRef, environmentId: string, role: string) {
    return this.config.removeConnectorRef(actor, environmentId, role);
  }
  listAuthorizations(environmentId: string) {
    return this.config.listAuthorizations(environmentId);
  }
  grantAuthorization(actor: ActorRef, environmentId: string, input: { justification: string; validFrom: string; validUntil: string }) {
    return this.config.grantAuthorization(actor, environmentId, input);
  }
  revokeAuthorization(actor: ActorRef, environmentId: string, id: string) {
    return this.config.revokeAuthorization(actor, environmentId, id);
  }
  async resolve(id: string): Promise<ResolvedEnvironment> {
    const detail = await this.get(id);
    return this.config.resolve(id, detail.selectable, detail.authorizationUntil);
  }
  async validate(id: string, ctx: { workflowType?: 'requirement-validation' | 'regression-testing'; parallelism?: number; prodSafe?: boolean } = {}): Promise<EnvironmentValidation> {
    const detail = await this.get(id);
    return this.config.validate(id, detail.selectable, detail.restrictions, detail.kind, ctx);
  }

  private applicationUrl(raw: string, hosts: ApprovedHost[]): string {
    return checkedApplicationUrl(raw, hosts);
  }
}
