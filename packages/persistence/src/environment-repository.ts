import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { AuthProfileRecord, AuthProfileType, ConnectorRefRecord, ConnectorRole, EnvironmentAuthorizationRecord, EnvironmentBrowser, EnvironmentKind, EnvironmentPatch, EnvironmentRecord, EnvironmentRepository, EnvironmentRestrictions, NewAuthorization, NewEnvironment, Reachability, SecretRefWrite, TestDataRecord } from '@qa/application';
import type { Db } from './db';
import { appUser, authProfile, connectorInstance, environment, environmentAuthorization, environmentConnectorRef, secretRef, testDataProfile } from './schema';

type Row = typeof environment.$inferSelect;

const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
};

const live = (id: string) => and(eq(environment.id, id), isNull(environment.deletedAt));

const toRecord = (r: Row): EnvironmentRecord => ({
  id: r.id,
  projectId: r.projectId,
  name: r.name,
  kind: r.kind as EnvironmentKind,
  applicationUrl: r.applicationUrl,
  ...(r.templatePreviewUrl ? { templatePreviewUrl: r.templatePreviewUrl } : {}),
  browser: r.browserConfig as unknown as EnvironmentBrowser,
  restrictions: r.executionRestrictions as unknown as EnvironmentRestrictions,
  enabled: r.enabled,
  reachability: r.reachability as Reachability,
  reachabilityDetail: r.reachabilityDetail ?? undefined,
  reachabilityCheckedAt: r.reachabilityCheckedAt ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class PgEnvironmentRepository implements EnvironmentRepository {
  constructor(private readonly db: Db) {}

  async list(filter?: { projectId?: string }): Promise<EnvironmentRecord[]> {
    const cond = filter?.projectId
      ? and(isNull(environment.deletedAt), eq(environment.projectId, filter.projectId))
      : isNull(environment.deletedAt);
    const rows = await this.db.select().from(environment).where(cond).orderBy(environment.name);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<EnvironmentRecord | undefined> {
    const [row] = await this.db.select().from(environment).where(live(id)).limit(1);
    return row && toRecord(row);
  }

  async insert(n: NewEnvironment): Promise<EnvironmentRecord> {
    try {
      const [row] = await this.db
        .insert(environment)
        .values({
          id: n.id,
          projectId: n.projectId,
          name: n.name,
          kind: n.kind,
          applicationUrl: n.applicationUrl,
          templatePreviewUrl: n.templatePreviewUrl || null,
          browserConfig: n.browser as unknown as Record<string, unknown>,
          executionRestrictions: n.restrictions as unknown as Record<string, unknown>,
          enabled: n.enabled,
        })
        .returning();
      return toRecord(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `An environment named "${n.name}" already exists in this project.`);
      throw e;
    }
  }

  async update(id: string, patch: EnvironmentPatch): Promise<EnvironmentRecord> {
    const set: Partial<typeof environment.$inferInsert> = { updatedAt: new Date(), rowVersion: sql`${environment.rowVersion} + 1` as unknown as number };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.applicationUrl !== undefined) set.applicationUrl = patch.applicationUrl;
    if (patch.templatePreviewUrl !== undefined) {
      set.templatePreviewUrl = patch.templatePreviewUrl && String(patch.templatePreviewUrl).trim()
        ? String(patch.templatePreviewUrl).trim()
        : null;
    }
    if (patch.browser !== undefined) set.browserConfig = patch.browser as unknown as Record<string, unknown>;
    if (patch.restrictions !== undefined) set.executionRestrictions = patch.restrictions as unknown as Record<string, unknown>;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    try {
      const [row] = await this.db.update(environment).set(set).where(live(id)).returning();
      if (!row) throw new PlatformError('not-found', 'Environment not found');
      return toRecord(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `An environment named "${patch.name}" already exists.`);
      throw e;
    }
  }

  async softDelete(id: string): Promise<void> {
    await this.db.update(environment).set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() }).where(live(id));
  }

  async activeAuthorization(environmentId: string, at: Date): Promise<EnvironmentAuthorizationRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(environmentAuthorization)
      .where(and(eq(environmentAuthorization.environmentId, environmentId), eq(environmentAuthorization.status, 'active'), lte(environmentAuthorization.validFrom, at), gt(environmentAuthorization.validUntil, at)))
      .limit(1);
    if (!row) return undefined;
    return { id: row.id, environmentId: row.environmentId, status: 'active', validFrom: row.validFrom, validUntil: row.validUntil };
  }

  async listAuthProfiles(environmentId: string): Promise<AuthProfileRecord[]> {
    const rows = await this.db
      .select({ profile: authProfile, locator: secretRef.locator })
      .from(authProfile)
      .leftJoin(secretRef, and(eq(secretRef.ownerType, 'auth_profile'), eq(secretRef.ownerId, authProfile.id)))
      .where(eq(authProfile.environmentId, environmentId))
      .orderBy(authProfile.name);
    return rows.map((r) => ({ id: r.profile.id, environmentId, name: r.profile.name, type: r.profile.type as AuthProfileType, config: asStrings(r.profile.config), hasSecret: !!r.locator, secretLocator: r.locator ?? undefined }));
  }

  async insertAuthProfile(rec: AuthProfileRecord): Promise<AuthProfileRecord> {
    try {
      await this.db.insert(authProfile).values({ id: rec.id, environmentId: rec.environmentId, name: rec.name, type: rec.type, config: rec.config });
      return rec;
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A profile named "${rec.name}" already exists on this environment.`);
      throw e;
    }
  }

  async updateAuthProfile(id: string, patch: Partial<Pick<AuthProfileRecord, 'name' | 'type' | 'config' | 'hasSecret' | 'secretLocator'>>): Promise<AuthProfileRecord> {
    const set: Partial<typeof authProfile.$inferInsert> = { updatedAt: new Date(), rowVersion: sql`${authProfile.rowVersion} + 1` as unknown as number };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.config !== undefined) set.config = patch.config;
    try {
      const [row] = await this.db.update(authProfile).set(set).where(eq(authProfile.id, id)).returning();
      if (!row) throw new PlatformError('not-found', 'Authentication profile not found');
      const [secret] = await this.db.select({ locator: secretRef.locator }).from(secretRef).where(and(eq(secretRef.ownerType, 'auth_profile'), eq(secretRef.ownerId, id))).limit(1);
      return { id: row.id, environmentId: row.environmentId, name: row.name, type: row.type as AuthProfileType, config: asStrings(row.config), hasSecret: patch.hasSecret === false ? false : !!secret, secretLocator: patch.hasSecret === false ? undefined : secret?.locator };
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A profile named "${patch.name}" already exists on this environment.`);
      throw e;
    }
  }

  async deleteAuthProfile(id: string): Promise<void> {
    await this.db.delete(authProfile).where(eq(authProfile.id, id));
    await this.deleteSecretRef('auth_profile', id);
  }

  async listTestData(environmentId: string): Promise<TestDataRecord[]> {
    const rows = await this.db
      .select({ profile: testDataProfile, locator: secretRef.locator })
      .from(testDataProfile)
      .leftJoin(secretRef, eq(secretRef.id, testDataProfile.secretRefId))
      .where(eq(testDataProfile.environmentId, environmentId))
      .orderBy(testDataProfile.name);
    return rows.map((r) => ({ id: r.profile.id, environmentId, name: r.profile.name, data: asStrings(r.profile.data), hasSecret: !!r.locator, secretLocator: r.locator ?? undefined }));
  }

  async insertTestData(rec: TestDataRecord): Promise<TestDataRecord> {
    try {
      await this.db.insert(testDataProfile).values({ id: rec.id, environmentId: rec.environmentId, name: rec.name, data: rec.data });
      return rec;
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A profile named "${rec.name}" already exists on this environment.`);
      throw e;
    }
  }

  async updateTestData(id: string, patch: Partial<Pick<TestDataRecord, 'name' | 'data' | 'hasSecret' | 'secretLocator'>>): Promise<TestDataRecord> {
    const set: Partial<typeof testDataProfile.$inferInsert> = { updatedAt: new Date(), rowVersion: sql`${testDataProfile.rowVersion} + 1` as unknown as number };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.data !== undefined) set.data = patch.data;
    if (patch.hasSecret === false) set.secretRefId = null;
    try {
      const [row] = await this.db.update(testDataProfile).set(set).where(eq(testDataProfile.id, id)).returning();
      if (!row) throw new PlatformError('not-found', 'Test data profile not found');
      const [secret] = row.secretRefId ? await this.db.select({ locator: secretRef.locator }).from(secretRef).where(eq(secretRef.id, row.secretRefId)).limit(1) : [];
      return { id: row.id, environmentId: row.environmentId, name: row.name, data: asStrings(row.data), hasSecret: !!secret, secretLocator: secret?.locator };
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A profile named "${patch.name}" already exists on this environment.`);
      throw e;
    }
  }

  async deleteTestData(id: string): Promise<void> {
    await this.db.delete(testDataProfile).where(eq(testDataProfile.id, id));
    await this.deleteSecretRef('test_data_profile', id);
  }

  async listConnectorRefs(environmentId: string): Promise<ConnectorRefRecord[]> {
    const rows = await this.db
      .select({ role: environmentConnectorRef.role, connectorInstanceId: environmentConnectorRef.connectorInstanceId, name: connectorInstance.name })
      .from(environmentConnectorRef)
      .innerJoin(connectorInstance, eq(connectorInstance.id, environmentConnectorRef.connectorInstanceId))
      .where(eq(environmentConnectorRef.environmentId, environmentId));
    return rows.map((r) => ({ environmentId, role: r.role as ConnectorRole, connectorInstanceId: r.connectorInstanceId, connectorName: r.name }));
  }

  async upsertConnectorRef(rec: ConnectorRefRecord): Promise<void> {
    await this.db
      .insert(environmentConnectorRef)
      .values({ environmentId: rec.environmentId, role: rec.role, connectorInstanceId: rec.connectorInstanceId })
      .onConflictDoUpdate({ target: [environmentConnectorRef.environmentId, environmentConnectorRef.role], set: { connectorInstanceId: rec.connectorInstanceId } });
  }

  async deleteConnectorRef(environmentId: string, role: ConnectorRole): Promise<void> {
    await this.db.delete(environmentConnectorRef).where(and(eq(environmentConnectorRef.environmentId, environmentId), eq(environmentConnectorRef.role, role)));
  }

  async listAuthorizations(environmentId: string): Promise<EnvironmentAuthorizationRecord[]> {
    const rows = await this.db
      .select({ auth: environmentAuthorization, name: appUser.displayName })
      .from(environmentAuthorization)
      .innerJoin(appUser, eq(appUser.id, environmentAuthorization.grantedBy))
      .where(eq(environmentAuthorization.environmentId, environmentId))
      .orderBy(environmentAuthorization.createdAt);
    return rows.map((r) => ({ id: r.auth.id, environmentId, status: r.auth.status as EnvironmentAuthorizationRecord['status'], validFrom: r.auth.validFrom, validUntil: r.auth.validUntil, justification: r.auth.justification, grantedByName: r.name }));
  }

  async insertAuthorization(rec: NewAuthorization): Promise<EnvironmentAuthorizationRecord> {
    try {
      const [row] = await this.db
        .insert(environmentAuthorization)
        .values({ id: rec.id, environmentId: rec.environmentId, grantedBy: rec.grantedBy, justification: rec.justification, validFrom: rec.validFrom, validUntil: rec.validUntil, status: 'active' })
        .returning();
      return { id: row!.id, environmentId: rec.environmentId, status: 'active', validFrom: row!.validFrom, validUntil: row!.validUntil, justification: rec.justification, grantedByName: rec.grantedByName };
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', 'Revoke the current production authorization before granting another.');
      throw e;
    }
  }

  async revokeAuthorization(id: string, environmentId: string): Promise<EnvironmentAuthorizationRecord | undefined> {
    const [row] = await this.db
      .update(environmentAuthorization)
      .set({ status: 'revoked' })
      .where(and(eq(environmentAuthorization.id, id), eq(environmentAuthorization.environmentId, environmentId), eq(environmentAuthorization.status, 'active')))
      .returning();
    if (!row) return undefined;
    return { id: row.id, environmentId, status: 'revoked', validFrom: row.validFrom, validUntil: row.validUntil, justification: row.justification };
  }

  async saveSecretRef(rec: SecretRefWrite): Promise<void> {
    const [existing] = await this.db.select({ id: secretRef.id }).from(secretRef).where(and(eq(secretRef.ownerType, rec.ownerType), eq(secretRef.ownerId, rec.ownerId))).limit(1);
    if (existing) {
      await this.db.update(secretRef).set({ version: rec.version, locator: rec.locator, store: rec.store, rotatedAt: new Date(), updatedAt: new Date() }).where(eq(secretRef.id, existing.id));
      if (rec.ownerType === 'test_data_profile') await this.db.update(testDataProfile).set({ secretRefId: existing.id }).where(eq(testDataProfile.id, rec.ownerId));
      return;
    }
    await this.db.insert(secretRef).values({ id: rec.id, store: rec.store, locator: rec.locator, version: rec.version, ownerType: rec.ownerType, ownerId: rec.ownerId, purpose: 'credentials', rotatedAt: new Date() });
    if (rec.ownerType === 'test_data_profile') await this.db.update(testDataProfile).set({ secretRefId: rec.id }).where(eq(testDataProfile.id, rec.ownerId));
  }

  async deleteSecretRef(ownerType: SecretRefWrite['ownerType'], ownerId: string): Promise<void> {
    if (ownerType === 'test_data_profile') await this.db.update(testDataProfile).set({ secretRefId: null }).where(eq(testDataProfile.id, ownerId));
    await this.db.delete(secretRef).where(and(eq(secretRef.ownerType, ownerType), eq(secretRef.ownerId, ownerId)));
  }

  async queueReachability(id: string): Promise<EnvironmentRecord> {
    const current = await this.get(id);
    if (!current) throw new PlatformError('not-found', 'Environment not found');
    if (current.reachability === 'queued' || current.reachability === 'checking') return current;
    const [row] = await this.db
      .update(environment)
      .set({ reachability: 'queued', reachabilityDetail: null, reachabilityCheckedAt: null, updatedAt: new Date() })
      .where(live(id))
      .returning();
    if (!row) throw new PlatformError('not-found', 'Environment not found');
    return toRecord(row);
  }

  async claimReachability(): Promise<EnvironmentRecord | undefined> {
    const [candidate] = await this.db.select({ id: environment.id }).from(environment).where(and(eq(environment.reachability, 'queued'), isNull(environment.deletedAt))).limit(1);
    if (!candidate) return undefined;
    const [row] = await this.db
      .update(environment)
      .set({ reachability: 'checking', updatedAt: new Date() })
      .where(and(eq(environment.id, candidate.id), eq(environment.reachability, 'queued'), isNull(environment.deletedAt)))
      .returning();
    return row && toRecord(row);
  }

  async finishReachability(id: string, result: 'reachable' | 'unreachable', detail: string, at: Date): Promise<void> {
    await this.db.update(environment).set({ reachability: result, reachabilityDetail: detail, reachabilityCheckedAt: at, updatedAt: at }).where(live(id));
  }

  async clearReachability(id: string): Promise<void> {
    await this.db.update(environment).set({ reachability: 'not-run', reachabilityDetail: null, reachabilityCheckedAt: null, updatedAt: new Date() }).where(live(id));
  }
}

const asStrings = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
};
