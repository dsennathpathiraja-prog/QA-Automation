import { PlatformError } from '@qa/domain';
import type {
  AutomationAssetInsert,
  AutomationAssetRecord,
  AutomationAssetStatus,
  AutomationMappingRecord,
  AutomationRepository,
} from '@qa/application';

export class InMemoryAutomationRepository implements AutomationRepository {
  readonly assets = new Map<string, AutomationAssetRecord>();
  readonly mappings = new Map<string, AutomationMappingRecord>();

  async listAssets(status?: AutomationAssetStatus) {
    return [...this.assets.values()]
      .filter((a) => (status ? a.status === status : true))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((a) => structuredClone(a));
  }

  async getAsset(id: string) {
    const row = this.assets.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async findAssetByKey(key: string) {
    const row = [...this.assets.values()].find((a) => a.key === key);
    return row ? structuredClone(row) : undefined;
  }

  async insertAsset(row: AutomationAssetInsert) {
    if ([...this.assets.values()].some((a) => a.key === row.key)) {
      throw new PlatformError('conflict', 'An automation asset with that key already exists.');
    }
    const now = new Date();
    const saved: AutomationAssetRecord = {
      id: row.id,
      key: row.key,
      name: row.name,
      scriptPath: row.scriptPath,
      scriptBody: row.scriptBody ?? '',
      status: row.status ?? 'draft',
      testCaseId: row.testCaseId,
      createdAt: now,
      updatedAt: now,
    };
    this.assets.set(saved.id, saved);
    return structuredClone(saved);
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
    const row = this.assets.get(id);
    if (!row) throw new PlatformError('not-found', 'Automation asset not found');
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.scriptPath !== undefined) row.scriptPath = patch.scriptPath;
    if (patch.scriptBody !== undefined) row.scriptBody = patch.scriptBody;
    if (patch.testCaseId !== undefined) row.testCaseId = patch.testCaseId ?? undefined;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.approvedBy !== undefined) row.approvedBy = patch.approvedBy ?? undefined;
    if (patch.approvedAt !== undefined) row.approvedAt = patch.approvedAt ?? undefined;
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async listMappings() {
    return [...this.mappings.values()]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((m) => structuredClone(m));
  }

  async findMappingBySquashCaseId(squashCaseId: string) {
    const row = this.mappings.get(squashCaseId);
    return row ? structuredClone(row) : undefined;
  }

  async upsertMapping(row: { id: string; squashCaseId: string; squashReference: string; assetId: string }) {
    const existing = this.mappings.get(row.squashCaseId);
    const now = new Date();
    if (existing) {
      existing.squashReference = row.squashReference;
      existing.assetId = row.assetId;
      existing.updatedAt = now;
      return structuredClone(existing);
    }
    const saved: AutomationMappingRecord = {
      id: row.id,
      squashCaseId: row.squashCaseId,
      squashReference: row.squashReference,
      assetId: row.assetId,
      createdAt: now,
      updatedAt: now,
    };
    this.mappings.set(row.squashCaseId, saved);
    return structuredClone(saved);
  }
}
