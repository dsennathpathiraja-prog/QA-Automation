import { PlatformError } from '@qa/domain';
import type {
  RegressionCollectionMemberRecord,
  RegressionCollectionRecord,
  RegressionCollectionRepository,
} from '@qa/application';

export class InMemoryRegressionCollectionRepository implements RegressionCollectionRepository {
  readonly collections = new Map<string, RegressionCollectionRecord>();
  readonly members = new Map<string, RegressionCollectionMemberRecord[]>();

  async listCollections() {
    return [...this.collections.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((c) => structuredClone(c));
  }

  async findByKey(key: string) {
    const row = [...this.collections.values()].find((c) => c.key === key);
    return row ? structuredClone(row) : undefined;
  }

  async insertCollection(row: { id: string; key: string; name: string; description: string }) {
    if ([...this.collections.values()].some((c) => c.key === row.key)) {
      throw new PlatformError('conflict', 'A regression collection with that key already exists.');
    }
    const now = new Date();
    const saved: RegressionCollectionRecord = {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      createdAt: now,
      updatedAt: now,
    };
    this.collections.set(saved.id, saved);
    this.members.set(saved.id, []);
    return structuredClone(saved);
  }

  async listMembers(collectionId: string) {
    return structuredClone(
      (this.members.get(collectionId) ?? []).sort((a, b) => a.position - b.position || a.squashCaseId.localeCompare(b.squashCaseId)),
    );
  }

  async replaceMembers(collectionId: string, squashCaseIds: readonly string[]) {
    const row = this.collections.get(collectionId);
    if (!row) throw new PlatformError('not-found', 'Regression collection not found');
    this.members.set(
      collectionId,
      squashCaseIds.map((squashCaseId, position) => ({ collectionId, squashCaseId, position })),
    );
    row.updatedAt = new Date();
  }

  async addMembers(collectionId: string, squashCaseIds: readonly string[]) {
    const row = this.collections.get(collectionId);
    if (!row) throw new PlatformError('not-found', 'Regression collection not found');
    const current = this.members.get(collectionId) ?? [];
    const have = new Set(current.map((m) => m.squashCaseId));
    let position = current.reduce((max, m) => Math.max(max, m.position), -1) + 1;
    for (const squashCaseId of squashCaseIds) {
      if (have.has(squashCaseId)) continue;
      current.push({ collectionId, squashCaseId, position: position++ });
      have.add(squashCaseId);
    }
    this.members.set(collectionId, current);
    row.updatedAt = new Date();
  }

  async removeMember(collectionId: string, squashCaseId: string) {
    const current = this.members.get(collectionId) ?? [];
    const next = current.filter((m) => m.squashCaseId !== squashCaseId);
    if (next.length === current.length) return false;
    this.members.set(collectionId, next);
    const row = this.collections.get(collectionId);
    if (row) row.updatedAt = new Date();
    return true;
  }
}
