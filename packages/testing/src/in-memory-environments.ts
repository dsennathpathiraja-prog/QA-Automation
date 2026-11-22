import { PlatformError } from '@qa/domain';
import type {
  AuthProfileRecord,
  ConnectorRefRecord,
  ConnectorRole,
  EnvironmentAuthorizationRecord,
  EnvironmentPatch,
  EnvironmentRecord,
  EnvironmentRepository,
  NewAuthorization,
  NewEnvironment,
  SecretRefWrite,
  TestDataRecord,
} from '@qa/application';

export class InMemoryEnvironmentRepository implements EnvironmentRepository {
  readonly rows = new Map<string, EnvironmentRecord>();
  readonly authorizations: EnvironmentAuthorizationRecord[] = [];
  readonly authProfiles: AuthProfileRecord[] = [];
  readonly testData: TestDataRecord[] = [];
  readonly connectorRefs: ConnectorRefRecord[] = [];
  readonly secretRefs: SecretRefWrite[] = [];

  async list() {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async insert(n: NewEnvironment) {
    if ([...this.rows.values()].some((r) => r.name.toLowerCase() === n.name.toLowerCase())) throw new PlatformError('conflict', `An environment named "${n.name}" already exists.`);
    const now = new Date();
    const rec: EnvironmentRecord = {
      id: n.id,
      name: n.name,
      kind: n.kind,
      applicationUrl: n.applicationUrl,
      ...(n.templatePreviewUrl ? { templatePreviewUrl: n.templatePreviewUrl } : {}),
      browser: n.browser,
      restrictions: n.restrictions,
      enabled: n.enabled,
      reachability: 'not-run',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(rec.id, structuredClone(rec));
    return structuredClone(rec);
  }

  async update(id: string, patch: EnvironmentPatch) {
    const row = this.rows.get(id);
    if (!row) throw new PlatformError('not-found', 'Environment not found');
    if (patch.name && [...this.rows.values()].some((r) => r.id !== id && r.name.toLowerCase() === patch.name!.toLowerCase())) {
      throw new PlatformError('conflict', `An environment named "${patch.name}" already exists.`);
    }
    const next = { ...row, updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) Object.assign(next, { [key]: value });
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async softDelete(id: string) {
    this.rows.delete(id);
    this.authProfiles.splice(0, this.authProfiles.length, ...this.authProfiles.filter((p) => p.environmentId !== id));
    this.testData.splice(0, this.testData.length, ...this.testData.filter((p) => p.environmentId !== id));
    this.connectorRefs.splice(0, this.connectorRefs.length, ...this.connectorRefs.filter((p) => p.environmentId !== id));
  }

  async activeAuthorization(environmentId: string, at: Date) {
    return this.authorizations.find((a) => a.environmentId === environmentId && a.status === 'active' && a.validFrom <= at && a.validUntil > at);
  }

  async listAuthProfiles(environmentId: string) {
    return this.authProfiles.filter((p) => p.environmentId === environmentId).map((p) => structuredClone(p));
  }

  async insertAuthProfile(rec: AuthProfileRecord) {
    this.assertProfileName(this.authProfiles, rec.environmentId, rec.name);
    this.authProfiles.push(structuredClone(rec));
    return structuredClone(rec);
  }

  async updateAuthProfile(id: string, patch: Partial<Pick<AuthProfileRecord, 'name' | 'type' | 'config' | 'hasSecret' | 'secretLocator'>>) {
    const row = this.authProfiles.find((p) => p.id === id);
    if (!row) throw new PlatformError('not-found', 'Authentication profile not found');
    if (patch.name) this.assertProfileName(this.authProfiles, row.environmentId, patch.name, id);
    Object.assign(row, defined(patch));
    if (patch.hasSecret === false) row.secretLocator = undefined;
    return structuredClone(row);
  }

  async deleteAuthProfile(id: string) {
    const row = this.authProfiles.find((p) => p.id === id);
    if (!row) return;
    this.authProfiles.splice(this.authProfiles.indexOf(row), 1);
    await this.deleteSecretRef('auth_profile', id);
  }

  async listTestData(environmentId: string) {
    return this.testData.filter((p) => p.environmentId === environmentId).map((p) => structuredClone(p));
  }

  async insertTestData(rec: TestDataRecord) {
    this.assertProfileName(this.testData, rec.environmentId, rec.name);
    this.testData.push(structuredClone(rec));
    return structuredClone(rec);
  }

  async updateTestData(id: string, patch: Partial<Pick<TestDataRecord, 'name' | 'data' | 'hasSecret' | 'secretLocator'>>) {
    const row = this.testData.find((p) => p.id === id);
    if (!row) throw new PlatformError('not-found', 'Test data profile not found');
    if (patch.name) this.assertProfileName(this.testData, row.environmentId, patch.name, id);
    Object.assign(row, defined(patch));
    if (patch.hasSecret === false) row.secretLocator = undefined;
    return structuredClone(row);
  }

  async deleteTestData(id: string) {
    const row = this.testData.find((p) => p.id === id);
    if (!row) return;
    this.testData.splice(this.testData.indexOf(row), 1);
    await this.deleteSecretRef('test_data_profile', id);
  }

  async listConnectorRefs(environmentId: string) {
    return this.connectorRefs.filter((r) => r.environmentId === environmentId).map((r) => structuredClone(r));
  }

  async upsertConnectorRef(rec: ConnectorRefRecord) {
    const i = this.connectorRefs.findIndex((r) => r.environmentId === rec.environmentId && r.role === rec.role);
    if (i >= 0) this.connectorRefs[i] = structuredClone(rec);
    else this.connectorRefs.push(structuredClone(rec));
  }

  async deleteConnectorRef(environmentId: string, role: ConnectorRole) {
    const i = this.connectorRefs.findIndex((r) => r.environmentId === environmentId && r.role === role);
    if (i >= 0) this.connectorRefs.splice(i, 1);
  }

  async listAuthorizations(environmentId: string) {
    return this.authorizations.filter((a) => a.environmentId === environmentId).map((a) => structuredClone(a));
  }

  async insertAuthorization(rec: NewAuthorization) {
    if (this.authorizations.some((a) => a.environmentId === rec.environmentId && a.status === 'active')) {
      throw new PlatformError('conflict', 'Revoke the current production authorization before granting another.');
    }
    const row: EnvironmentAuthorizationRecord = { id: rec.id, environmentId: rec.environmentId, status: 'active', validFrom: rec.validFrom, validUntil: rec.validUntil, justification: rec.justification, grantedByName: rec.grantedByName };
    this.authorizations.push(row);
    return structuredClone(row);
  }

  async revokeAuthorization(id: string, environmentId: string) {
    const row = this.authorizations.find((a) => a.id === id && a.environmentId === environmentId && a.status === 'active');
    if (!row) return undefined;
    row.status = 'revoked';
    return structuredClone(row);
  }

  async saveSecretRef(rec: SecretRefWrite) {
    const i = this.secretRefs.findIndex((r) => r.ownerType === rec.ownerType && r.ownerId === rec.ownerId);
    if (i >= 0) this.secretRefs[i] = { ...this.secretRefs[i]!, ...rec, id: this.secretRefs[i]!.id };
    else this.secretRefs.push({ ...rec });
  }

  async deleteSecretRef(ownerType: SecretRefWrite['ownerType'], ownerId: string) {
    const i = this.secretRefs.findIndex((r) => r.ownerType === ownerType && r.ownerId === ownerId);
    if (i >= 0) this.secretRefs.splice(i, 1);
  }

  async queueReachability(id: string) {
    const row = this.rows.get(id);
    if (!row) throw new PlatformError('not-found', 'Environment not found');
    if (row.reachability !== 'queued' && row.reachability !== 'checking') {
      row.reachability = 'queued';
      row.reachabilityDetail = undefined;
      row.reachabilityCheckedAt = undefined;
      row.updatedAt = new Date();
    }
    return structuredClone(row);
  }

  async claimReachability() {
    const row = [...this.rows.values()].find((r) => r.reachability === 'queued');
    if (!row) return undefined;
    row.reachability = 'checking';
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async finishReachability(id: string, result: 'reachable' | 'unreachable', detail: string, at: Date) {
    const row = this.rows.get(id);
    if (!row) return;
    row.reachability = result;
    row.reachabilityDetail = detail;
    row.reachabilityCheckedAt = at;
    row.updatedAt = at;
  }

  async clearReachability(id: string) {
    const row = this.rows.get(id);
    if (!row) return;
    row.reachability = 'not-run';
    row.reachabilityDetail = undefined;
    row.reachabilityCheckedAt = undefined;
    row.updatedAt = new Date();
  }

  private assertProfileName(rows: { id: string; environmentId: string; name: string }[], environmentId: string, name: string, except?: string) {
    if (rows.some((r) => r.environmentId === environmentId && r.id !== except && r.name.toLowerCase() === name.toLowerCase())) {
      throw new PlatformError('conflict', `A profile named "${name}" already exists on this environment.`);
    }
  }
}

const defined = (patch: object) => Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
