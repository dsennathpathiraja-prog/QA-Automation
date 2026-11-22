import { and, asc, eq } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type {
  RegressionCollectionMemberRecord,
  RegressionCollectionRecord,
  RegressionCollectionRepository,
} from '@qa/application';
import type { Db } from './db';
import { regressionCollection, regressionCollectionMember } from './schema';

const collectionOf = (r: typeof regressionCollection.$inferSelect): RegressionCollectionRecord => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class PgRegressionCollectionRepository implements RegressionCollectionRepository {
  constructor(private readonly db: Db) {}

  async listCollections() {
    const rows = await this.db.select().from(regressionCollection).orderBy(asc(regressionCollection.key));
    return rows.map(collectionOf);
  }

  async findByKey(key: string) {
    const [row] = await this.db.select().from(regressionCollection).where(eq(regressionCollection.key, key)).limit(1);
    return row && collectionOf(row);
  }

  async insertCollection(row: { id: string; key: string; name: string; description: string }) {
    try {
      const [saved] = await this.db.insert(regressionCollection).values({
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
      }).returning();
      return collectionOf(saved!);
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string } };
      if (err.code === '23505' || err.cause?.code === '23505') {
        throw new PlatformError('conflict', 'A regression collection with that key already exists.');
      }
      throw e;
    }
  }

  async listMembers(collectionId: string): Promise<RegressionCollectionMemberRecord[]> {
    const rows = await this.db
      .select()
      .from(regressionCollectionMember)
      .where(eq(regressionCollectionMember.collectionId, collectionId))
      .orderBy(asc(regressionCollectionMember.position), asc(regressionCollectionMember.squashCaseId));
    return rows.map((r) => ({
      collectionId: r.collectionId,
      squashCaseId: r.squashCaseId,
      position: r.position,
    }));
  }

  async replaceMembers(collectionId: string, squashCaseIds: readonly string[]) {
    await this.db.transaction(async (tx) => {
      await tx.delete(regressionCollectionMember).where(eq(regressionCollectionMember.collectionId, collectionId));
      if (squashCaseIds.length === 0) {
        await tx.update(regressionCollection).set({ updatedAt: new Date() }).where(eq(regressionCollection.id, collectionId));
        return;
      }
      await tx.insert(regressionCollectionMember).values(
        squashCaseIds.map((squashCaseId, position) => ({ collectionId, squashCaseId, position })),
      );
      await tx.update(regressionCollection).set({ updatedAt: new Date() }).where(eq(regressionCollection.id, collectionId));
    });
  }

  async addMembers(collectionId: string, squashCaseIds: readonly string[]) {
    if (squashCaseIds.length === 0) return;
    const existing = await this.listMembers(collectionId);
    const have = new Set(existing.map((m) => m.squashCaseId));
    const toAdd = squashCaseIds.filter((id) => !have.has(id));
    if (toAdd.length === 0) return;
    let position = existing.reduce((max, m) => Math.max(max, m.position), -1) + 1;
    await this.db.insert(regressionCollectionMember).values(
      toAdd.map((squashCaseId) => ({ collectionId, squashCaseId, position: position++ })),
    ).onConflictDoNothing({
      target: [regressionCollectionMember.collectionId, regressionCollectionMember.squashCaseId],
    });
    await this.db.update(regressionCollection).set({ updatedAt: new Date() }).where(eq(regressionCollection.id, collectionId));
  }

  async removeMember(collectionId: string, squashCaseId: string) {
    const removed = await this.db
      .delete(regressionCollectionMember)
      .where(and(
        eq(regressionCollectionMember.collectionId, collectionId),
        eq(regressionCollectionMember.squashCaseId, squashCaseId),
      ))
      .returning();
    if (removed.length > 0) {
      await this.db.update(regressionCollection).set({ updatedAt: new Date() }).where(eq(regressionCollection.id, collectionId));
    }
    return removed.length > 0;
  }
}
