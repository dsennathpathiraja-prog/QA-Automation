import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { CollectionCaseRecord, TestCaseRecord, TestCaseRepository, TestCaseVersionRecord, TestCollectionRecord } from '@qa/application';
import type { Db } from './db';
import { testCase, testCaseVersion, testCollection, testCollectionCase } from './schema';

const caseOf = (r: typeof testCase.$inferSelect): TestCaseRecord => ({
  id: r.id,
  key: r.key,
  name: r.name,
  summary: r.summary,
  workItem: r.workItem,
  currentVersion: r.currentVersion,
  updatedAt: r.updatedAt,
});

const versionOf = (r: typeof testCaseVersion.$inferSelect): TestCaseVersionRecord => ({
  version: r.version,
  steps: r.steps,
  expected: r.expected,
  createdAt: r.createdAt,
});

const unique = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code === '23505' || err.cause?.code === '23505';
};

export class PgTestCaseRepository implements TestCaseRepository {
  constructor(private readonly db: Db) {}

  async list() {
    const rows = await this.db.select().from(testCase).where(sql`${testCase.deletedAt} is null`).orderBy(desc(testCase.updatedAt));
    return rows.map(caseOf);
  }

  async get(id: string) {
    const [row] = await this.db.select().from(testCase).where(and(eq(testCase.id, id), sql`${testCase.deletedAt} is null`)).limit(1);
    return row && caseOf(row);
  }

  async findKey(key: string) {
    const [row] = await this.db.select().from(testCase).where(and(eq(testCase.key, key), sql`${testCase.deletedAt} is null`)).limit(1);
    return row && caseOf(row);
  }

  async insert(row: { id: string; key: string; name: string; summary: string; workItem: string; steps: string; expected: string }) {
    try {
      return await this.db.transaction(async (tx) => {
        const [saved] = await tx.insert(testCase).values({ id: row.id, key: row.key, name: row.name, summary: row.summary, workItem: row.workItem }).returning();
        await tx.insert(testCaseVersion).values({ testCaseId: row.id, version: 1, steps: row.steps, expected: row.expected });
        return caseOf(saved!);
      });
    } catch (e) {
      if (unique(e)) throw new PlatformError('conflict', 'A test case with that name already exists.');
      throw e;
    }
  }

  async current(id: string) {
    const row = await this.get(id);
    if (!row) return undefined;
    const [version] = await this.db.select().from(testCaseVersion).where(and(eq(testCaseVersion.testCaseId, id), eq(testCaseVersion.version, row.currentVersion))).limit(1);
    return version && versionOf(version);
  }

  async versions(id: string) {
    const rows = await this.db.select().from(testCaseVersion).where(eq(testCaseVersion.testCaseId, id)).orderBy(desc(testCaseVersion.version));
    return rows.map(versionOf);
  }

  async saveVersion(id: string, version: number, steps: string, expected: string, summary: string) {
    const [saved] = await this.db.transaction(async (tx) => {
      await tx.insert(testCaseVersion).values({ testCaseId: id, version, steps, expected });
      return tx.update(testCase).set({ currentVersion: version, summary, updatedAt: new Date() }).where(eq(testCase.id, id)).returning();
    });
    return caseOf(saved!);
  }

  async saveSummary(id: string, summary: string) {
    const [saved] = await this.db.update(testCase).set({ summary, updatedAt: new Date() }).where(eq(testCase.id, id)).returning();
    if (!saved) throw new PlatformError('not-found', 'Test case not found');
    return caseOf(saved);
  }

  async listCollections() {
    const rows = await this.db.select().from(testCollection).where(sql`${testCollection.deletedAt} is null`).orderBy(desc(testCollection.updatedAt));
    const counts = await this.db.select({ collectionId: testCollectionCase.collectionId, n: sql<number>`count(*)::int` }).from(testCollectionCase).groupBy(testCollectionCase.collectionId);
    const size = new Map(counts.map((c) => [c.collectionId, Number(c.n)]));
    return rows.map((r): TestCollectionRecord => ({ id: r.id, name: r.name, description: r.description, size: size.get(r.id) ?? 0 }));
  }

  async getCollection(id: string) {
    const [row] = await this.db.select().from(testCollection).where(and(eq(testCollection.id, id), sql`${testCollection.deletedAt} is null`)).limit(1);
    if (!row) return undefined;
    const cases = await this.db
      .select({ id: testCase.id, name: testCase.name, version: testCase.currentVersion, position: testCollectionCase.position })
      .from(testCollectionCase)
      .innerJoin(testCase, eq(testCase.id, testCollectionCase.testCaseId))
      .where(and(eq(testCollectionCase.collectionId, id), sql`${testCase.deletedAt} is null`))
      .orderBy(asc(testCollectionCase.position));
    return { id: row.id, name: row.name, description: row.description, cases: cases satisfies CollectionCaseRecord[] };
  }

  async insertCollection(row: { id: string; name: string; description: string }) {
    try {
      const [saved] = await this.db.insert(testCollection).values(row).returning();
      return { id: saved!.id, name: saved!.name, description: saved!.description, size: 0 };
    } catch (e) {
      if (unique(e)) throw new PlatformError('conflict', 'A collection with that name already exists.');
      throw e;
    }
  }

  async addCase(collectionId: string, testCaseId: string) {
    const [last] = await this.db.select({ position: testCollectionCase.position }).from(testCollectionCase).where(eq(testCollectionCase.collectionId, collectionId)).orderBy(desc(testCollectionCase.position)).limit(1);
    try {
      await this.db.insert(testCollectionCase).values({ collectionId, testCaseId, position: (last?.position ?? 0) + 1 });
      return 'added' as const;
    } catch (e) {
      if (unique(e)) return 'exists' as const;
      throw e;
    }
  }

  async removeCase(collectionId: string, testCaseId: string) {
    const removed = await this.db.delete(testCollectionCase).where(and(eq(testCollectionCase.collectionId, collectionId), eq(testCollectionCase.testCaseId, testCaseId))).returning();
    return removed.length > 0;
  }
}
