import { and, desc, eq } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type {
  AutomationAssetInsert,
  AutomationAssetRecord,
  AutomationAssetStatus,
  AutomationMappingRecord,
  AutomationRepository,
} from '@qa/application';
import type { Db } from './db';
import { automationAsset, automationMapping } from './schema';

const asStatus = (value: string): AutomationAssetStatus => (value === 'approved' ? 'approved' : 'draft');

const assetOf = (r: typeof automationAsset.$inferSelect): AutomationAssetRecord => ({
  id: r.id,
  key: r.key,
  name: r.name,
  scriptPath: r.scriptPath,
  scriptBody: r.scriptBody,
  status: asStatus(r.status),
  testCaseId: r.testCaseId ?? undefined,
  approvedBy: r.approvedBy ?? undefined,
  approvedAt: r.approvedAt ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const mappingOf = (r: typeof automationMapping.$inferSelect): AutomationMappingRecord => ({
  id: r.id,
  squashCaseId: r.squashCaseId,
  squashReference: r.squashReference,
  assetId: r.assetId,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const unique = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code === '23505' || err.cause?.code === '23505';
};

export class PgAutomationRepository implements AutomationRepository {
  constructor(private readonly db: Db) {}

  async listAssets(status?: AutomationAssetStatus) {
    const rows = status
      ? await this.db.select().from(automationAsset).where(eq(automationAsset.status, status)).orderBy(desc(automationAsset.updatedAt))
      : await this.db.select().from(automationAsset).orderBy(desc(automationAsset.updatedAt));
    return rows.map(assetOf);
  }

  async getAsset(id: string) {
    const [row] = await this.db.select().from(automationAsset).where(eq(automationAsset.id, id)).limit(1);
    return row && assetOf(row);
  }

  async findAssetByKey(key: string) {
    const [row] = await this.db.select().from(automationAsset).where(eq(automationAsset.key, key)).limit(1);
    return row && assetOf(row);
  }

  async insertAsset(row: AutomationAssetInsert) {
    try {
      const [saved] = await this.db.insert(automationAsset).values({
        id: row.id,
        key: row.key,
        name: row.name,
        scriptPath: row.scriptPath,
        scriptBody: row.scriptBody ?? '',
        status: row.status ?? 'draft',
        testCaseId: row.testCaseId,
      }).returning();
      return assetOf(saved!);
    } catch (e) {
      if (unique(e)) throw new PlatformError('conflict', 'An automation asset with that key already exists.');
      throw e;
    }
  }

  async updateAsset(
    id: string,
    patch: {
      name?: string;
      scriptPath?: string;
      scriptBody?: string;
      testCaseId?: string | null;
      status?: AutomationAssetStatus;
      approvedBy?: string | null;
      approvedAt?: Date | null;
    },
  ) {
    const set: Partial<typeof automationAsset.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.scriptPath !== undefined) set.scriptPath = patch.scriptPath;
    if (patch.scriptBody !== undefined) set.scriptBody = patch.scriptBody;
    if (patch.testCaseId !== undefined) set.testCaseId = patch.testCaseId;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.approvedBy !== undefined) set.approvedBy = patch.approvedBy;
    if (patch.approvedAt !== undefined) set.approvedAt = patch.approvedAt;
    const [saved] = await this.db.update(automationAsset).set(set).where(eq(automationAsset.id, id)).returning();
    if (!saved) throw new PlatformError('not-found', 'Automation asset not found');
    return assetOf(saved);
  }

  async listMappings() {
    const rows = await this.db.select().from(automationMapping).orderBy(desc(automationMapping.updatedAt));
    return rows.map(mappingOf);
  }

  async findMappingBySquashCaseId(squashCaseId: string) {
    const [row] = await this.db.select().from(automationMapping).where(eq(automationMapping.squashCaseId, squashCaseId)).limit(1);
    return row && mappingOf(row);
  }

  async upsertMapping(row: { id: string; squashCaseId: string; squashReference: string; assetId: string }) {
    const existing = await this.findMappingBySquashCaseId(row.squashCaseId);
    if (existing) {
      const [saved] = await this.db
        .update(automationMapping)
        .set({ squashReference: row.squashReference, assetId: row.assetId, updatedAt: new Date() })
        .where(eq(automationMapping.id, existing.id))
        .returning();
      return mappingOf(saved!);
    }
    try {
      const [saved] = await this.db.insert(automationMapping).values({
        id: row.id,
        squashCaseId: row.squashCaseId,
        squashReference: row.squashReference,
        assetId: row.assetId,
      }).returning();
      return mappingOf(saved!);
    } catch (e) {
      if (unique(e)) {
        const again = await this.findMappingBySquashCaseId(row.squashCaseId);
        if (again) {
          const [saved] = await this.db
            .update(automationMapping)
            .set({ squashReference: row.squashReference, assetId: row.assetId, updatedAt: new Date() })
            .where(and(eq(automationMapping.id, again.id)))
            .returning();
          return mappingOf(saved!);
        }
      }
      throw e;
    }
  }
}
