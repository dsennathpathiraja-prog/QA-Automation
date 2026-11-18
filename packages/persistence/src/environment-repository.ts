import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { EnvironmentAuthorizationRecord, EnvironmentBrowser, EnvironmentKind, EnvironmentPatch, EnvironmentRecord, EnvironmentRepository, EnvironmentRestrictions, NewEnvironment } from '@qa/application';
import type { Db } from './db';
import { environment, environmentAuthorization } from './schema';

type Row = typeof environment.$inferSelect;

const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
};

const live = (id: string) => and(eq(environment.id, id), isNull(environment.deletedAt));

const toRecord = (r: Row): EnvironmentRecord => ({
  id: r.id,
  name: r.name,
  kind: r.kind as EnvironmentKind,
  applicationUrl: r.applicationUrl,
  browser: r.browserConfig as unknown as EnvironmentBrowser,
  restrictions: r.executionRestrictions as unknown as EnvironmentRestrictions,
  enabled: r.enabled,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class PgEnvironmentRepository implements EnvironmentRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<EnvironmentRecord[]> {
    const rows = await this.db.select().from(environment).where(isNull(environment.deletedAt)).orderBy(environment.name);
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
          name: n.name,
          kind: n.kind,
          applicationUrl: n.applicationUrl,
          browserConfig: n.browser as unknown as Record<string, unknown>,
          executionRestrictions: n.restrictions as unknown as Record<string, unknown>,
          enabled: n.enabled,
        })
        .returning();
      return toRecord(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `An environment named "${n.name}" already exists.`);
      throw e;
    }
  }

  async update(id: string, patch: EnvironmentPatch): Promise<EnvironmentRecord> {
    const set: Partial<typeof environment.$inferInsert> = { updatedAt: new Date(), rowVersion: sql`${environment.rowVersion} + 1` as unknown as number };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.applicationUrl !== undefined) set.applicationUrl = patch.applicationUrl;
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
}
