import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { ActorRef } from './connector-service';
import type { AuditSink } from './ports';
import { uniqueCaseIds } from './automation-service';

export interface RegressionCollectionRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegressionCollectionMemberRecord {
  collectionId: string;
  squashCaseId: string;
  position: number;
}

export interface RegressionCollectionView {
  id: string;
  key: string;
  name: string;
  description: string;
  squashCaseIds: string[];
  size: number;
  updatedAt: string;
}

export interface RegressionCollectionListItem {
  id: string;
  key: string;
  name: string;
  description: string;
  size: number;
  updatedAt: string;
}

export interface RegressionCollectionRepository {
  listCollections(): Promise<RegressionCollectionRecord[]>;
  findByKey(key: string): Promise<RegressionCollectionRecord | undefined>;
  insertCollection(row: { id: string; key: string; name: string; description: string }): Promise<RegressionCollectionRecord>;
  listMembers(collectionId: string): Promise<RegressionCollectionMemberRecord[]>;
  replaceMembers(collectionId: string, squashCaseIds: readonly string[]): Promise<void>;
  addMembers(collectionId: string, squashCaseIds: readonly string[]): Promise<void>;
  removeMember(collectionId: string, squashCaseId: string): Promise<boolean>;
}

const SMOKE_KEY = 'smoke';

const viewOf = async (
  row: RegressionCollectionRecord,
  members: RegressionCollectionMemberRecord[],
): Promise<RegressionCollectionView> => {
  const squashCaseIds = uniqueCaseIds(members.map((m) => m.squashCaseId));
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    squashCaseIds,
    size: squashCaseIds.length,
    updatedAt: row.updatedAt.toISOString(),
  };
};

/**
 * Phase 9 E4 — curated platform regression collections (at least `smoke`).
 * Members are Squash case ids — no Squash tag dependency.
 */
export class RegressionCollectionService {
  constructor(private readonly d: { collections: RegressionCollectionRepository; audit: AuditSink }) {}

  async list(): Promise<RegressionCollectionListItem[]> {
    const rows = await this.d.collections.listCollections();
    const out: RegressionCollectionListItem[] = [];
    for (const row of rows) {
      const members = await this.d.collections.listMembers(row.id);
      out.push({
        id: row.id,
        key: row.key,
        name: row.name,
        description: row.description,
        size: members.length,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return out;
  }

  async getByKey(key: string): Promise<RegressionCollectionView> {
    const row = await this.requireByKey(key);
    return viewOf(row, await this.d.collections.listMembers(row.id));
  }

  /** Squash case ids for Regression scope; `undefined` when the collection key does not exist. */
  async caseIdsForKey(key: string): Promise<string[] | undefined> {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return undefined;
    const row = await this.d.collections.findByKey(normalized);
    if (!row) return undefined;
    const members = await this.d.collections.listMembers(row.id);
    return uniqueCaseIds(members.map((m) => m.squashCaseId));
  }

  async ensureSmoke(): Promise<RegressionCollectionView> {
    const existing = await this.d.collections.findByKey(SMOKE_KEY);
    if (existing) return viewOf(existing, await this.d.collections.listMembers(existing.id));
    const created = await this.d.collections.insertCollection({
      id: randomUUID(),
      key: SMOKE_KEY,
      name: 'Smoke',
      description: 'Curated platform smoke collection for Regression template #7 (Squash case id members).',
    });
    await this.d.audit.append({
      actorId: 'system',
      action: 'regression.collection.ensure',
      subjectType: 'regression_collection',
      subjectId: created.id,
      detail: { key: SMOKE_KEY },
    });
    return viewOf(created, []);
  }

  async replaceMembers(actor: ActorRef, key: string, squashCaseIds: readonly string[]): Promise<RegressionCollectionView> {
    const row = await this.requireByKey(key);
    const ids = uniqueCaseIds(squashCaseIds);
    await this.d.collections.replaceMembers(row.id, ids);
    await this.d.audit.append({
      actorId: actor.id,
      action: 'regression.collection.members.replace',
      subjectType: 'regression_collection',
      subjectId: row.id,
      detail: { key: row.key, size: ids.length },
    });
    return this.getByKey(row.key);
  }

  async addMembers(actor: ActorRef, key: string, squashCaseIds: readonly string[]): Promise<RegressionCollectionView> {
    const row = await this.requireByKey(key);
    const ids = uniqueCaseIds(squashCaseIds);
    await this.d.collections.addMembers(row.id, ids);
    await this.d.audit.append({
      actorId: actor.id,
      action: 'regression.collection.members.add',
      subjectType: 'regression_collection',
      subjectId: row.id,
      detail: { key: row.key, added: ids.length },
    });
    return this.getByKey(row.key);
  }

  /**
   * Replace members with Squash case ids from approved automation mappings.
   * Keeps smoke compatible with seed/approve without Squash tags.
   */
  async syncFromApprovedMappings(
    actor: ActorRef,
    key: string,
    listApprovedSquashCaseIds: () => Promise<string[]>,
  ): Promise<RegressionCollectionView> {
    const ids = uniqueCaseIds(await listApprovedSquashCaseIds());
    return this.replaceMembers(actor, key, ids);
  }

  private async requireByKey(key: string): Promise<RegressionCollectionRecord> {
    const normalized = key.trim().toLowerCase();
    if (!normalized) throw new PlatformError('validation', 'A regression collection key is required.');
    const row = await this.d.collections.findByKey(normalized);
    if (!row) throw new PlatformError('not-found', `Platform regression collection "${normalized}" was not found.`);
    return row;
  }
}
