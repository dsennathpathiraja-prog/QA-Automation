import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { CaseRunStatus, CollectionCaseRecord, TestCaseInsert, TestCaseKind, TestCasePriority, TestCaseRecord, TestCaseRepository, TestCaseVersionRecord, TestCollectionRecord, WorkItemCaseResultRecord, WorkItemRunRecord, WorkItemRunStatus } from '@qa/application';
import type { Db } from './db';
import { testCase, testCaseVersion, testCollection, testCollectionCase, workItemCaseResult, workItemExecution } from './schema';

const asKind = (value: string): TestCaseKind => (value === 'negative' || value === 'edge' ? value : 'positive');
const asPriority = (value: string): TestCasePriority => (value === 'high' || value === 'low' ? value : 'medium');

const caseOf = (r: typeof testCase.$inferSelect): TestCaseRecord => ({
  id: r.id,
  key: r.key,
  name: r.name,
  summary: r.summary,
  workItem: r.workItem,
  kind: asKind(r.kind),
  priority: asPriority(r.priority),
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

  async insert(row: TestCaseInsert) {
    try {
      return await this.db.transaction(async (tx) => {
        const [saved] = await tx.insert(testCase).values({
          id: row.id,
          key: row.key,
          name: row.name,
          summary: row.summary,
          workItem: row.workItem,
          kind: row.kind,
          priority: row.priority,
        }).returning();
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

  async saveIdentity(id: string, patch: { name?: string; key?: string; kind?: TestCaseKind; priority?: TestCasePriority }) {
    const set: Partial<typeof testCase.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.key !== undefined) set.key = patch.key;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.priority !== undefined) set.priority = patch.priority;
    try {
      const [saved] = await this.db.update(testCase).set(set).where(and(eq(testCase.id, id), sql`${testCase.deletedAt} is null`)).returning();
      if (!saved) throw new PlatformError('not-found', 'Test case not found');
      return caseOf(saved);
    } catch (e) {
      if (unique(e)) throw new PlatformError('conflict', 'A test case with that name already exists.');
      throw e;
    }
  }

  async softDelete(id: string) {
    return this.db.transaction(async (tx) => {
      await tx.delete(testCollectionCase).where(eq(testCollectionCase.testCaseId, id));
      const [saved] = await tx
        .update(testCase)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(testCase.id, id), sql`${testCase.deletedAt} is null`))
        .returning({ id: testCase.id });
      return Boolean(saved);
    });
  }

  async softDeleteAllPlatform() {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.delete(testCollectionCase);
      const cases = await tx
        .update(testCase)
        .set({ deletedAt: now, updatedAt: now })
        .where(sql`${testCase.deletedAt} is null`)
        .returning({ id: testCase.id });
      const collections = await tx
        .update(testCollection)
        .set({ deletedAt: now, updatedAt: now })
        .where(sql`${testCollection.deletedAt} is null`)
        .returning({ id: testCollection.id });
      return { cases: cases.length, collections: collections.length };
    });
  }

  async listCollections() {
    const rows = await this.db.select().from(testCollection).where(sql`${testCollection.deletedAt} is null`).orderBy(desc(testCollection.updatedAt));
    // Count only live (non soft-deleted) members so size matches the collection detail and execution board.
    const counts = await this.db
      .select({ collectionId: testCollectionCase.collectionId, n: sql<number>`count(*)::int` })
      .from(testCollectionCase)
      .innerJoin(testCase, eq(testCase.id, testCollectionCase.testCaseId))
      .where(sql`${testCase.deletedAt} is null`)
      .groupBy(testCollectionCase.collectionId);
    const size = new Map(counts.map((c) => [c.collectionId, Number(c.n)]));
    return rows.map((r): TestCollectionRecord => ({ id: r.id, name: r.name, description: r.description, size: size.get(r.id) ?? 0 }));
  }

  async getCollection(id: string) {
    const [row] = await this.db.select().from(testCollection).where(and(eq(testCollection.id, id), sql`${testCollection.deletedAt} is null`)).limit(1);
    if (!row) return undefined;
    const cases = await this.db
      .select({
        id: testCase.id,
        name: testCase.name,
        version: testCase.currentVersion,
        position: testCollectionCase.position,
        kind: testCase.kind,
        priority: testCase.priority,
      })
      .from(testCollectionCase)
      .innerJoin(testCase, eq(testCase.id, testCollectionCase.testCaseId))
      .where(and(eq(testCollectionCase.collectionId, id), sql`${testCase.deletedAt} is null`))
      .orderBy(asc(testCollectionCase.position));
    const mapped: CollectionCaseRecord[] = cases.map((c) => ({
      id: c.id,
      name: c.name,
      version: c.version,
      position: c.position,
      kind: asKind(c.kind),
      priority: asPriority(c.priority),
    }));
    return { id: row.id, name: row.name, description: row.description, cases: mapped };
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

  /**
   * Soft-deletes the collection and every member case on the platform.
   * Version rows stay; Squash copies are not touched.
   */
  async softDeleteCollection(id: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select({ id: testCollection.id }).from(testCollection).where(and(eq(testCollection.id, id), sql`${testCollection.deletedAt} is null`)).limit(1);
      if (!row) return false;
      const members = await tx.select({ testCaseId: testCollectionCase.testCaseId }).from(testCollectionCase).where(eq(testCollectionCase.collectionId, id));
      await tx.delete(testCollectionCase).where(eq(testCollectionCase.collectionId, id));
      for (const member of members) {
        await tx.delete(testCollectionCase).where(eq(testCollectionCase.testCaseId, member.testCaseId));
        await tx
          .update(testCase)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(testCase.id, member.testCaseId), sql`${testCase.deletedAt} is null`));
      }
      await tx.update(testCollection).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(testCollection.id, id));
      return true;
    });
  }

  async listWorkItemRuns() {
    const rows = await this.db.select().from(workItemExecution).orderBy(desc(workItemExecution.createdAt));
    return rows.map((r) => this.runOf(r));
  }

  async getWorkItemRun(id: string) {
    const [row] = await this.db.select().from(workItemExecution).where(eq(workItemExecution.id, id)).limit(1);
    return row && this.runOf(row);
  }

  async insertWorkItemRun(row: { id: string; workItem: string; environmentId: string; environmentName: string; caseCount: number }) {
    const [saved] = await this.db.insert(workItemExecution).values(row).returning();
    return this.runOf(saved!);
  }

  async updateWorkItemRun(id: string, patch: { status: WorkItemRunStatus; squashSync?: string; finishedAt?: Date }) {
    const [saved] = await this.db
      .update(workItemExecution)
      .set({ status: patch.status, squashSync: patch.squashSync, finishedAt: patch.finishedAt })
      .where(eq(workItemExecution.id, id))
      .returning();
    if (!saved) throw new PlatformError('not-found', 'Work item execution not found');
    return this.runOf(saved);
  }

  async claimQueuedWorkItemRun() {
    const [candidate] = await this.db
      .select({ id: workItemExecution.id })
      .from(workItemExecution)
      .where(eq(workItemExecution.status, 'queued'))
      .orderBy(asc(workItemExecution.createdAt))
      .limit(1);
    if (!candidate) return undefined;
    const [saved] = await this.db
      .update(workItemExecution)
      .set({ status: 'running' })
      .where(and(eq(workItemExecution.id, candidate.id), eq(workItemExecution.status, 'queued')))
      .returning();
    return saved && this.runOf(saved);
  }

  async replaceCaseResults(executionId: string, results: Array<{ id: string; testCaseId: string; name: string; status: CaseRunStatus; message: string; screenshotPng?: string; squashExecutionId?: string }>) {
    await this.db.transaction(async (tx) => {
      await tx.delete(workItemCaseResult).where(eq(workItemCaseResult.executionId, executionId));
      if (results.length === 0) return;
      await tx.insert(workItemCaseResult).values(results.map((r) => ({
        id: r.id,
        executionId,
        testCaseId: r.testCaseId,
        name: r.name,
        status: r.status,
        message: r.message,
        screenshotPng: r.screenshotPng,
        squashExecutionId: r.squashExecutionId,
      })));
    });
  }

  async listCaseResults(executionId: string) {
    const rows = await this.db.select().from(workItemCaseResult).where(eq(workItemCaseResult.executionId, executionId)).orderBy(asc(workItemCaseResult.createdAt));
    return rows.map((r): WorkItemCaseResultRecord => ({
      id: r.id,
      testCaseId: r.testCaseId,
      name: r.name,
      status: r.status as CaseRunStatus,
      message: r.message,
      screenshotPng: r.screenshotPng ?? undefined,
      squashExecutionId: r.squashExecutionId ?? undefined,
    }));
  }

  async getCaseResult(executionId: string, testCaseId: string) {
    const [row] = await this.db
      .select()
      .from(workItemCaseResult)
      .where(and(eq(workItemCaseResult.executionId, executionId), eq(workItemCaseResult.testCaseId, testCaseId)))
      .limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      testCaseId: row.testCaseId,
      name: row.name,
      status: row.status as CaseRunStatus,
      message: row.message,
      screenshotPng: row.screenshotPng ?? undefined,
      squashExecutionId: row.squashExecutionId ?? undefined,
    } satisfies WorkItemCaseResultRecord;
  }

  private runOf(r: typeof workItemExecution.$inferSelect): WorkItemRunRecord {
    return {
      id: r.id,
      workItem: r.workItem,
      environmentId: r.environmentId,
      environmentName: r.environmentName,
      caseCount: r.caseCount,
      status: r.status as WorkItemRunStatus,
      squashSync: r.squashSync ?? undefined,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt ?? undefined,
    };
  }
}
