import { randomUUID } from 'node:crypto';
import { PlatformError, type SecretStore } from '@qa/domain';
import type { ActorRef } from './connector-service';
import { authConfig, authType, checkedApplicationUrl, profileName, requiredSecret, restrictionIssues, stringMap } from './environment-rules';
import {
  CONNECTOR_ROLES,
  type ApprovedHostRepository,
  type AuditSink,
  type AuthProfileRecord,
  type ConnectorLookup,
  type ConnectorRefRecord,
  type ConnectorRole,
  type EnvironmentAuthorizationRecord,
  type EnvironmentBrowser,
  type EnvironmentRepository,
  type EnvironmentRestrictions,
  type SecretRefWrite,
  type TestDataRecord,
  type UserDirectory,
} from './ports';

export interface AuthProfileView {
  id: string;
  name: string;
  type: AuthProfileRecord['type'];
  config: Record<string, string>;
  hasSecret: boolean;
}

export interface TestDataView {
  id: string;
  name: string;
  data: Record<string, string>;
  hasSecret: boolean;
}

export interface ResolvedEnvironment {
  id: string;
  name: string;
  kind: string;
  applicationUrl: string;
  browser: EnvironmentBrowser;
  restrictions: EnvironmentRestrictions;
  selectable: boolean;
  authorizationUntil?: string;
  authProfiles: AuthProfileView[];
  testDataProfiles: TestDataView[];
  connectors: { role: ConnectorRole; connectorId: string; name: string }[];
  connectivity: 'not-run';
}

export interface EnvironmentValidation {
  ok: boolean;
  selectable: boolean;
  connectivity: 'not-run';
  errors: { message: string }[];
}

type Deps = {
  environments: EnvironmentRepository;
  hosts: ApprovedHostRepository;
  audit: AuditSink;
  secrets?: Pick<SecretStore, 'put' | 'exists' | 'delete'>;
  secretStoreKind?: SecretRefWrite['store'];
  users?: UserDirectory;
  connectors?: ConnectorLookup;
};

const secretKey = (type: AuthProfileRecord['type']) => (type === 'bearer' ? 'token' : type === 'storage-state' ? 'storageState' : type === 'none' ? undefined : 'password');

const viewAuth = (r: AuthProfileRecord): AuthProfileView => ({ id: r.id, name: r.name, type: r.type, config: r.config, hasSecret: r.hasSecret });
const viewData = (r: TestDataRecord): TestDataView => ({ id: r.id, name: r.name, data: r.data, hasSecret: r.hasSecret });

export class EnvironmentConfig {
  constructor(private readonly d: Deps, private readonly clock: { now(): Date }) {}

  async listAuthProfiles(environmentId: string) {
    await this.requireEnv(environmentId);
    return (await this.d.environments.listAuthProfiles(environmentId)).map(viewAuth);
  }

  async createAuthProfile(actor: ActorRef, environmentId: string, input: { name: string; type: string; config?: Record<string, string>; secrets?: Record<string, string> }) {
    await this.requireEnv(environmentId);
    const type = authType(input.type);
    const hosts = await this.d.hosts.list('application');
    const config = authConfig(type, input.config, hosts);
    const secrets = requiredSecret(type, input.secrets, false);
    const id = randomUUID();
    const locator = `environments/${environmentId}/auth/${id}`;
    let rec = await this.d.environments.insertAuthProfile({ id, environmentId, name: profileName(input.name), type, config, hasSecret: false });
    try {
      if (secrets) rec = await this.storeSecret(rec, 'auth_profile', locator, secrets);
    } catch (e) {
      await this.d.environments.deleteAuthProfile(id).catch(() => undefined);
      throw e;
    }
    await this.d.audit.append({ actorId: actor.id, action: 'environment.auth_profile.create', subjectType: 'auth_profile', subjectId: id, detail: { environmentId, name: rec.name, type, credentialsStored: rec.hasSecret } });
    return viewAuth(rec);
  }

  async updateAuthProfile(actor: ActorRef, environmentId: string, id: string, input: { name?: string; type?: string; config?: Record<string, string>; secrets?: Record<string, string> }) {
    const current = await this.requireAuth(environmentId, id);
    const type = input.type === undefined ? current.type : authType(input.type);
    const hosts = await this.d.hosts.list('application');
    const config = input.config === undefined && input.type === undefined ? current.config : authConfig(type, input.config ?? current.config, hosts);
    const secrets = requiredSecret(type, input.secrets, true);
    const secretKeyChanged = secretKey(type) !== secretKey(current.type);
    if (type !== 'none' && secretKeyChanged && !secrets) throw new PlatformError('validation', 'Changing the authentication type needs the new secret. It is stored encrypted and is never shown again.');
    let rec = await this.d.environments.updateAuthProfile(id, { name: input.name === undefined ? undefined : profileName(input.name), type, config, hasSecret: type === 'none' ? false : current.hasSecret });
    if (type === 'none' && current.secretLocator) {
      await this.d.secrets?.delete(current.secretLocator);
      await this.d.environments.deleteSecretRef('auth_profile', id);
      rec = { ...rec, hasSecret: false, secretLocator: undefined };
    } else if (secrets) {
      rec = await this.storeSecret(rec, 'auth_profile', current.secretLocator ?? `environments/${environmentId}/auth/${id}`, secrets);
    } else if (type !== 'none' && !rec.hasSecret) {
      throw new PlatformError('validation', 'This profile has no stored secret yet. Enter one before saving.');
    }
    await this.d.audit.append({ actorId: actor.id, action: 'environment.auth_profile.update', subjectType: 'auth_profile', subjectId: id, detail: { name: rec.name, type, credentialsReplaced: !!secrets } });
    return viewAuth(rec);
  }

  async deleteAuthProfile(actor: ActorRef, environmentId: string, id: string) {
    const current = await this.requireAuth(environmentId, id);
    await this.d.environments.deleteAuthProfile(id);
    if (current.secretLocator) await this.d.secrets?.delete(current.secretLocator);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.auth_profile.delete', subjectType: 'auth_profile', subjectId: id, detail: { name: current.name } });
  }

  async listTestData(environmentId: string) {
    await this.requireEnv(environmentId);
    return (await this.d.environments.listTestData(environmentId)).map(viewData);
  }

  async createTestData(actor: ActorRef, environmentId: string, input: { name: string; data?: Record<string, string>; secrets?: Record<string, string> }) {
    await this.requireEnv(environmentId);
    const id = randomUUID();
    const data = stringMap(input.data, 'Test data');
    const secrets = input.secrets ? stringMap(input.secrets, 'Secret test data') : undefined;
    let rec = await this.d.environments.insertTestData({ id, environmentId, name: profileName(input.name), data, hasSecret: false });
    try {
      if (secrets && Object.keys(secrets).length > 0) rec = await this.storeSecret(rec, 'test_data_profile', `environments/${environmentId}/testdata/${id}`, secrets);
    } catch (e) {
      await this.d.environments.deleteTestData(id).catch(() => undefined);
      throw e;
    }
    await this.d.audit.append({ actorId: actor.id, action: 'environment.test_data.create', subjectType: 'test_data_profile', subjectId: id, detail: { environmentId, name: rec.name, credentialsStored: rec.hasSecret } });
    return viewData(rec);
  }

  async updateTestData(actor: ActorRef, environmentId: string, id: string, input: { name?: string; data?: Record<string, string>; secrets?: Record<string, string> }) {
    const current = await this.requireData(environmentId, id);
    const data = input.data === undefined ? current.data : stringMap(input.data, 'Test data');
    let rec = await this.d.environments.updateTestData(id, { name: input.name === undefined ? undefined : profileName(input.name), data });
    if (input.secrets) {
      const secrets = stringMap(input.secrets, 'Secret test data');
      if (Object.keys(secrets).length === 0) {
        if (current.secretLocator) await this.d.secrets?.delete(current.secretLocator);
        await this.d.environments.deleteSecretRef('test_data_profile', id);
        rec = await this.d.environments.updateTestData(id, { hasSecret: false, secretLocator: undefined });
      } else {
        rec = await this.storeSecret(rec, 'test_data_profile', current.secretLocator ?? `environments/${environmentId}/testdata/${id}`, secrets);
      }
    }
    await this.d.audit.append({ actorId: actor.id, action: 'environment.test_data.update', subjectType: 'test_data_profile', subjectId: id, detail: { name: rec.name, credentialsReplaced: input.secrets !== undefined } });
    return viewData(rec);
  }

  async deleteTestData(actor: ActorRef, environmentId: string, id: string) {
    const current = await this.requireData(environmentId, id);
    await this.d.environments.deleteTestData(id);
    if (current.secretLocator) await this.d.secrets?.delete(current.secretLocator);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.test_data.delete', subjectType: 'test_data_profile', subjectId: id, detail: { name: current.name } });
  }

  async listConnectorRefs(environmentId: string) {
    await this.requireEnv(environmentId);
    return this.d.environments.listConnectorRefs(environmentId);
  }

  async setConnectorRef(actor: ActorRef, environmentId: string, input: { role: string; connectorId: string }) {
    await this.requireEnv(environmentId);
    if (!(CONNECTOR_ROLES as readonly string[]).includes(input.role)) throw new PlatformError('validation', 'Connector role must be work item, source repository, test management, or browser automation.');
    const role = input.role as ConnectorRole;
    const connector = await this.d.connectors?.get(input.connectorId);
    if (!connector) throw new PlatformError('validation', 'Choose a connector that already exists.');
    if (connector.category !== role) throw new PlatformError('validation', `That connector is a ${connector.category} connector, so it cannot fill the ${role} role.`);
    if (!connector.enabled) throw new PlatformError('validation', `Enable "${connector.name}" before attaching it to an environment.`);
    const rec: ConnectorRefRecord = { environmentId, role, connectorInstanceId: connector.id, connectorName: connector.name };
    await this.d.environments.upsertConnectorRef(rec);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.connector_ref.set', subjectType: 'environment', subjectId: environmentId, detail: { role, connectorId: connector.id } });
    return rec;
  }

  async removeConnectorRef(actor: ActorRef, environmentId: string, role: string) {
    await this.requireEnv(environmentId);
    if (!(CONNECTOR_ROLES as readonly string[]).includes(role)) throw new PlatformError('not-found', 'Connector reference not found');
    await this.d.environments.deleteConnectorRef(environmentId, role as ConnectorRole);
    await this.d.audit.append({ actorId: actor.id, action: 'environment.connector_ref.remove', subjectType: 'environment', subjectId: environmentId, detail: { role } });
  }

  async listAuthorizations(environmentId: string) {
    await this.requireEnv(environmentId);
    return (await this.d.environments.listAuthorizations(environmentId)).map(this.authView);
  }

  async grantAuthorization(actor: ActorRef, environmentId: string, input: { justification: string; validFrom: string; validUntil: string }) {
    const env = await this.requireEnv(environmentId);
    if (env.kind !== 'production') throw new PlatformError('validation', 'Only a production environment needs an authorization.');
    const justification = input.justification.trim();
    if (justification.length < 8 || justification.length > 500) throw new PlatformError('validation', 'Write why production runs are allowed, in 8 to 500 characters.');
    const validFrom = this.instant(input.validFrom, 'The start of the authorization window');
    const validUntil = this.instant(input.validUntil, 'The end of the authorization window');
    if (validUntil <= validFrom) throw new PlatformError('validation', 'The authorization must end after it starts.');
    if (validUntil.getTime() - validFrom.getTime() > 366 * 24 * 60 * 60 * 1000) throw new PlatformError('validation', 'An authorization can last at most 366 days. Grant a new one when this window ends.');
    if (validUntil <= this.clock.now()) throw new PlatformError('validation', 'The authorization window has already ended.');
    const user = await this.d.users?.findBySubject(actor.id);
    if (!user) throw new PlatformError('validation', 'This account is not registered in the platform yet. Sign out and sign in again, then grant the authorization.');
    const rec = await this.d.environments.insertAuthorization({ id: randomUUID(), environmentId, grantedBy: user.id, grantedByName: user.displayName, justification, validFrom, validUntil });
    await this.d.audit.append({ actorId: actor.id, action: 'environment.authorization.grant', subjectType: 'environment_authorization', subjectId: rec.id, detail: { environmentId, validUntil: validUntil.toISOString() } });
    return this.authView(rec);
  }

  async revokeAuthorization(actor: ActorRef, environmentId: string, id: string) {
    await this.requireEnv(environmentId);
    const rec = await this.d.environments.revokeAuthorization(id, environmentId);
    if (!rec) throw new PlatformError('not-found', 'Authorization not found');
    await this.d.audit.append({ actorId: actor.id, action: 'environment.authorization.revoke', subjectType: 'environment_authorization', subjectId: id, detail: { environmentId } });
    return this.authView(rec);
  }

  async resolve(environmentId: string, selectable: boolean, authorizationUntil?: string): Promise<ResolvedEnvironment> {
    const env = await this.requireEnv(environmentId);
    const [authProfiles, testDataProfiles, connectors] = await Promise.all([
      this.d.environments.listAuthProfiles(environmentId),
      this.d.environments.listTestData(environmentId),
      this.d.environments.listConnectorRefs(environmentId),
    ]);
    return {
      id: env.id,
      name: env.name,
      kind: env.kind,
      applicationUrl: env.applicationUrl,
      browser: env.browser,
      restrictions: env.restrictions,
      selectable,
      authorizationUntil,
      authProfiles: authProfiles.map(viewAuth),
      testDataProfiles: testDataProfiles.map(viewData),
      connectors: connectors.map((c) => ({ role: c.role, connectorId: c.connectorInstanceId, name: c.connectorName })),
      connectivity: 'not-run',
    };
  }

  async validate(environmentId: string, selectable: boolean, restrictions: EnvironmentRestrictions, kind: string, ctx: { workflowType?: 'requirement-validation' | 'regression-testing'; parallelism?: number; prodSafe?: boolean }): Promise<EnvironmentValidation> {
    const errors: string[] = [];
    const env = await this.requireEnv(environmentId);
    if (!env.enabled) errors.push('Enable this environment before a run can select it.');
    try {
      checkedApplicationUrl(env.applicationUrl, await this.d.hosts.list('application'));
    } catch (e) {
      errors.push(e instanceof PlatformError ? e.message : 'The application address is not valid.');
    }
    if (kind === 'production' && !selectable) errors.push('Production is not authorized. An Administrator must grant an authorization that is still inside its window.');
    errors.push(...restrictionIssues(restrictions, ctx));
    for (const ref of await this.d.environments.listConnectorRefs(environmentId)) {
      const connector = await this.d.connectors?.get(ref.connectorInstanceId);
      if (!connector || !connector.enabled) errors.push(`The ${ref.role} connector "${ref.connectorName}" is switched off. Enable it, or choose another.`);
    }
    return { ok: errors.length === 0, selectable, connectivity: 'not-run', errors: errors.map((message) => ({ message })) };
  }

  private authView = (r: EnvironmentAuthorizationRecord) => ({
    id: r.id,
    status: r.status,
    validFrom: r.validFrom.toISOString(),
    validUntil: r.validUntil.toISOString(),
    justification: r.justification ?? '',
    grantedByName: r.grantedByName ?? '',
    active: r.status === 'active' && r.validFrom <= this.clock.now() && r.validUntil > this.clock.now(),
  });

  private async storeSecret<T extends { id: string; hasSecret: boolean; secretLocator?: string }>(rec: T, ownerType: SecretRefWrite['ownerType'], locator: string, material: Record<string, string>): Promise<T> {
    const secrets = this.d.secrets;
    const store = this.d.secretStoreKind;
    if (!secrets || !store) throw new PlatformError('unsupported', 'No secret store is configured, so credentials cannot be saved. Set SECRET_STORE or BAO_ADDR.');
    const { version } = await secrets.put(locator, material);
    await this.d.environments.saveSecretRef({ id: randomUUID(), store, locator, version, ownerType, ownerId: rec.id });
    const patch = { hasSecret: true, secretLocator: locator };
    const saved = ownerType === 'auth_profile' ? await this.d.environments.updateAuthProfile(rec.id, patch) : await this.d.environments.updateTestData(rec.id, patch);
    return saved as unknown as T;
  }

  private async requireEnv(id: string) {
    const row = await this.d.environments.get(id);
    if (!row) throw new PlatformError('not-found', 'Environment not found');
    return row;
  }

  private async requireAuth(environmentId: string, id: string) {
    const row = (await this.d.environments.listAuthProfiles(environmentId)).find((p) => p.id === id);
    if (!row) throw new PlatformError('not-found', 'Authentication profile not found');
    return row;
  }

  private async requireData(environmentId: string, id: string) {
    const row = (await this.d.environments.listTestData(environmentId)).find((p) => p.id === id);
    if (!row) throw new PlatformError('not-found', 'Test data profile not found');
    return row;
  }

  private instant(raw: string, label: string): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new PlatformError('validation', `${label} is not a valid date.`);
    return d;
  }
}
