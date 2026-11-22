import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { ActorRef } from './connector-service';
import type { AuditSink } from './ports';

export type AutomationAssetStatus = 'draft' | 'approved';

export interface AutomationAssetRecord {
  id: string;
  key: string;
  name: string;
  scriptPath: string;
  scriptBody: string;
  status: AutomationAssetStatus;
  testCaseId?: string;
  approvedBy?: string;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationMappingRecord {
  id: string;
  squashCaseId: string;
  squashReference: string;
  assetId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationMappingView {
  id: string;
  squashCaseId: string;
  squashReference: string;
  assetId: string;
  assetKey: string;
  assetName: string;
  scriptPath: string;
  status: AutomationAssetStatus;
  updatedAt: string;
}

export interface AutomationResolveResult {
  squashCaseId: string;
  squashReference: string;
  assetId: string;
  assetKey: string;
  assetName: string;
  scriptPath: string;
  status: AutomationAssetStatus;
  approved: boolean;
}

export interface AutomationAssetInsert {
  id: string;
  key: string;
  name: string;
  scriptPath: string;
  scriptBody?: string;
  testCaseId?: string;
  status?: AutomationAssetStatus;
}

export interface AutomationRepository {
  listAssets(status?: AutomationAssetStatus): Promise<AutomationAssetRecord[]>;
  getAsset(id: string): Promise<AutomationAssetRecord | undefined>;
  findAssetByKey(key: string): Promise<AutomationAssetRecord | undefined>;
  insertAsset(row: AutomationAssetInsert): Promise<AutomationAssetRecord>;
  updateAsset(
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
  ): Promise<AutomationAssetRecord>;
  listMappings(): Promise<AutomationMappingRecord[]>;
  findMappingBySquashCaseId(squashCaseId: string): Promise<AutomationMappingRecord | undefined>;
  upsertMapping(row: { id: string; squashCaseId: string; squashReference: string; assetId: string }): Promise<AutomationMappingRecord>;
}

const viewOf = (asset: AutomationAssetRecord) => ({
  id: asset.id,
  key: asset.key,
  name: asset.name,
  scriptPath: asset.scriptPath,
  scriptBody: asset.scriptBody,
  status: asset.status,
  testCaseId: asset.testCaseId,
  approvedBy: asset.approvedBy,
  approvedAt: asset.approvedAt?.toISOString(),
  createdAt: asset.createdAt.toISOString(),
  updatedAt: asset.updatedAt.toISOString(),
});

export class AutomationService {
  constructor(private readonly d: { automation: AutomationRepository; audit: AuditSink }) {}

  async listAssets(status?: AutomationAssetStatus) {
    return (await this.d.automation.listAssets(status)).map(viewOf);
  }

  async getAsset(id: string) {
    const row = await this.d.automation.getAsset(id);
    if (!row) throw new PlatformError('not-found', 'Automation asset not found');
    return viewOf(row);
  }

  async listMappings(): Promise<AutomationMappingView[]> {
    const [mappings, assets] = await Promise.all([this.d.automation.listMappings(), this.d.automation.listAssets()]);
    const byId = new Map(assets.map((a) => [a.id, a]));
    return mappings
      .map((m) => {
        const asset = byId.get(m.assetId);
        if (!asset) return undefined;
        return {
          id: m.id,
          squashCaseId: m.squashCaseId,
          squashReference: m.squashReference,
          assetId: asset.id,
          assetKey: asset.key,
          assetName: asset.name,
          scriptPath: asset.scriptPath,
          status: asset.status,
          updatedAt: m.updatedAt.toISOString(),
        } satisfies AutomationMappingView;
      })
      .filter((row): row is AutomationMappingView => !!row)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Resolve a Squash case id to the linked platform automation asset.
   * Returns draft or approved; Regression runners should require `approved`.
   */
  async resolveBySquashCaseId(squashCaseId: string): Promise<AutomationResolveResult> {
    const id = squashCaseId.trim();
    if (!id) throw new PlatformError('validation', 'A Squash case id is required.');
    const mapping = await this.d.automation.findMappingBySquashCaseId(id);
    if (!mapping) throw new PlatformError('not-found', 'No automation mapping exists for that Squash case.');
    const asset = await this.d.automation.getAsset(mapping.assetId);
    if (!asset) throw new PlatformError('not-found', 'The mapped automation asset is missing.');
    return {
      squashCaseId: mapping.squashCaseId,
      squashReference: mapping.squashReference,
      assetId: asset.id,
      assetKey: asset.key,
      assetName: asset.name,
      scriptPath: asset.scriptPath,
      status: asset.status,
      approved: asset.status === 'approved',
    };
  }

  async register(
    actor: ActorRef,
    input: { key: string; name: string; scriptPath: string; scriptBody?: string; testCaseId?: string; squashCaseId?: string; squashReference?: string },
  ) {
    const key = input.key.trim();
    const name = input.name.trim();
    const scriptPath = input.scriptPath.trim();
    if (!key) throw new PlatformError('validation', 'An automation asset key is required.');
    if (!name) throw new PlatformError('validation', 'An automation asset name is required.');
    if (!scriptPath) throw new PlatformError('validation', 'A platform script path is required.');

    const existing = await this.d.automation.findAssetByKey(key);
    let asset: AutomationAssetRecord;
    if (existing) {
      asset = await this.d.automation.updateAsset(existing.id, {
        name,
        scriptPath,
        scriptBody: input.scriptBody ?? existing.scriptBody,
        testCaseId: input.testCaseId ?? existing.testCaseId ?? null,
        // Re-register keeps draft unless already approved.
        status: existing.status === 'approved' ? 'approved' : 'draft',
      });
    } else {
      asset = await this.d.automation.insertAsset({
        id: randomUUID(),
        key,
        name,
        scriptPath,
        scriptBody: input.scriptBody ?? '',
        testCaseId: input.testCaseId,
        status: 'draft',
      });
    }

    await this.d.audit.append({
      actorId: actor.id,
      action: 'automation.register',
      subjectType: 'automation_asset',
      subjectId: asset.id,
      detail: { key: asset.key, scriptPath: asset.scriptPath, status: asset.status },
    });

    if (input.squashCaseId?.trim()) {
      await this.linkSquash(actor, {
        squashCaseId: input.squashCaseId.trim(),
        squashReference: (input.squashReference ?? key).trim(),
        assetId: asset.id,
      });
    }

    return viewOf(asset);
  }

  async approve(actor: ActorRef, assetId: string) {
    const current = await this.d.automation.getAsset(assetId);
    if (!current) throw new PlatformError('not-found', 'Automation asset not found');
    if (current.status === 'approved') return viewOf(current);
    const saved = await this.d.automation.updateAsset(assetId, {
      status: 'approved',
      approvedBy: actor.id,
      approvedAt: new Date(),
    });
    await this.d.audit.append({
      actorId: actor.id,
      action: 'automation.approve',
      subjectType: 'automation_asset',
      subjectId: assetId,
      detail: { key: saved.key },
    });
    return viewOf(saved);
  }

  async linkSquash(actor: ActorRef, input: { squashCaseId: string; squashReference?: string; assetId: string }) {
    const squashCaseId = input.squashCaseId.trim();
    if (!squashCaseId) throw new PlatformError('validation', 'A Squash case id is required.');
    const asset = await this.d.automation.getAsset(input.assetId);
    if (!asset) throw new PlatformError('not-found', 'Automation asset not found');
    const mapping = await this.d.automation.upsertMapping({
      id: randomUUID(),
      squashCaseId,
      squashReference: (input.squashReference ?? asset.key).trim(),
      assetId: asset.id,
    });
    await this.d.audit.append({
      actorId: actor.id,
      action: 'automation.map',
      subjectType: 'automation_mapping',
      subjectId: mapping.id,
      detail: { squashCaseId, assetId: asset.id, reference: mapping.squashReference },
    });
    return mapping;
  }

  /**
   * Worker seed after Squash upsert: draft asset + mapping for the Squash case id.
   * Idempotent on asset key and squash case id.
   */
  async seedFromPublish(
    actor: ActorRef,
    input: {
      key: string;
      name: string;
      scriptPath: string;
      scriptBody?: string;
      testCaseId?: string;
      squashCaseId: string;
      squashReference?: string;
    },
  ) {
    return this.register(actor, {
      key: input.key,
      name: input.name,
      scriptPath: input.scriptPath,
      scriptBody: input.scriptBody,
      testCaseId: input.testCaseId,
      squashCaseId: input.squashCaseId,
      squashReference: input.squashReference ?? input.key,
    });
  }
}
