import { PlatformError } from '@qa/domain';
import { uniqueCaseIds } from './automation-service';

/** How Regression selects Squash cases before approved-only resolve (Phase 9 E3). */
export type RegressionScopeKind = 'suite' | 'campaign' | 'collection' | 'selected';

export interface RegressionScopeInput {
  kind: RegressionScopeKind;
  /** Squash project id (required for suite / campaign). */
  projectId?: string;
  /** Optional Squash suite / folder id — only when the connector probe supports `tm.suite.list`. */
  suiteId?: string;
  /** Squash campaign id (required for campaign). */
  campaignId?: string;
  /** Optional iteration; when omitted, all iterations under the campaign are included. */
  iterationId?: string;
  /** Platform collection key (e.g. `smoke`); curated members land in E4. */
  collectionKey?: string;
  /** Explicit Squash case ids (selected mode, or overrides). */
  caseIds?: readonly string[];
}

export interface RegressionScopeResult {
  caseIds: string[];
  kind: RegressionScopeKind;
  /** Template-facing mode label. */
  mode: 'all-in-suite' | 'selected' | 'regression-collection' | 'campaign';
  projectId?: string;
  suiteId?: string;
  campaignId?: string;
  iterationId?: string;
  collectionKey?: string;
}

export type ScopeCapability =
  | 'tm.testcase.list'
  | 'tm.campaign.list'
  | 'tm.iteration.list'
  | 'tm.suite.list'
  | 'tm.iteration.testplan.list';

export type ScopeSupport = 'supported' | 'partial' | 'unsupported';

/** Squash reads used to expand suite / campaign scope (worker wires ConnectorExecutionManager). */
export interface RegressionScopeSquashPort {
  probeSupport(capability: ScopeCapability): Promise<ScopeSupport>;
  listProjectCaseIds(projectId: string): Promise<string[]>;
  listCampaignCaseIds(input: { projectId: string; campaignId: string; iterationId?: string }): Promise<string[]>;
}

/** Platform collection key → Squash case ids (stub until E4 curated smoke). */
export interface RegressionScopeCollectionPort {
  caseIdsForCollectionKey(key: string): Promise<string[] | undefined>;
}

const text = (raw: unknown): string =>
  (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '');

const asRecord = (raw: unknown): Record<string, unknown> | undefined => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  return undefined;
};

const asStringList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return uniqueCaseIds(raw.map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : '')));
  }
  if (typeof raw === 'string') return uniqueCaseIds(raw.split(/[\s,;]+/));
  return [];
};

/**
 * Normalize wizard / step params into a scope request.
 * Accepts `squashScope` + `selection` (templates) or a flat scope body (prep API).
 */
export function parseRegressionScopeInput(raw: unknown): RegressionScopeInput {
  const root = asRecord(raw) ?? {};
  const squash = asRecord(root.squashScope) ?? asRecord(root.scope) ?? {};
  const selection = asRecord(root.selection) ?? {};
  const config = asRecord(root.config) ?? {};

  const projectId = text(root.projectId) || text(squash.projectId) || text(squash.project) || text(selection.projectId);
  const suiteId = text(root.suiteId) || text(squash.suiteId) || text(squash.suite) || text(selection.suiteId);
  const campaignId = text(root.campaignId) || text(squash.campaignId) || text(squash.campaign) || text(selection.campaignId);
  const iterationId = text(root.iterationId) || text(squash.iterationId) || text(squash.iteration) || text(selection.iterationId);
  const collectionKey = text(root.collectionKey) || text(selection.collectionKey) || text(config.collectionKey) || text(squash.collectionKey);
  const caseIds = asStringList(
    root.caseIds
    ?? root.squashCaseIds
    ?? selection.caseIds
    ?? selection.squashCaseIds
    ?? selection.selectedCaseIds
    ?? squash.caseIds,
  );

  const modeRaw = text(root.kind) || text(root.mode) || text(selection.mode) || text(config.mode) || text(squash.mode);
  const mode = modeRaw.toLowerCase();

  if (mode === 'selected' || mode === 'selection') {
    return { kind: 'selected', projectId: projectId || undefined, caseIds };
  }
  if (mode === 'regression-collection' || mode === 'collection' || mode === 'smoke' || collectionKey) {
    return {
      kind: 'collection',
      collectionKey: collectionKey || (mode === 'smoke' ? 'smoke' : undefined),
      caseIds: caseIds.length > 0 ? caseIds : undefined,
      projectId: projectId || undefined,
    };
  }
  if (mode === 'campaign' || campaignId) {
    return {
      kind: 'campaign',
      projectId: projectId || undefined,
      campaignId: campaignId || undefined,
      iterationId: iterationId || undefined,
      caseIds: caseIds.length > 0 ? caseIds : undefined,
    };
  }
  if (mode === 'all-in-suite' || mode === 'suite' || mode === 'all' || suiteId || projectId) {
    return {
      kind: 'suite',
      projectId: projectId || undefined,
      suiteId: suiteId || undefined,
      caseIds: caseIds.length > 0 ? caseIds : undefined,
    };
  }
  if (caseIds.length > 0) return { kind: 'selected', caseIds };
  throw new PlatformError(
    'validation',
    'Regression scope needs a suite (project), campaign, platform collectionKey, or selected Squash case ids.',
  );
}

function emptyScopeError(what: string): never {
  throw new PlatformError('validation', `${what} — nothing for Regression to resolve.`);
}

function requireProject(projectId: string | undefined): string {
  const id = text(projectId);
  if (!id) throw new PlatformError('validation', 'A Squash project id is required for suite or campaign scope.');
  return id;
}

/**
 * Phase 9 E3 — expand suite / campaign / collection / selected into ordered unique Squash case ids.
 */
export class RegressionScopeService {
  constructor(
    private readonly deps: {
      squash?: RegressionScopeSquashPort;
      collections?: RegressionScopeCollectionPort;
    } = {},
  ) {}

  async resolve(input: RegressionScopeInput): Promise<RegressionScopeResult> {
    switch (input.kind) {
      case 'selected':
        return this.selected(input);
      case 'collection':
        return this.collection(input);
      case 'suite':
        return this.suite(input);
      case 'campaign':
        return this.campaign(input);
      default:
        throw new PlatformError('validation', `Unknown Regression scope kind.`);
    }
  }

  private selected(input: RegressionScopeInput): RegressionScopeResult {
    const caseIds = uniqueCaseIds(input.caseIds ?? []);
    if (caseIds.length === 0) emptyScopeError('Selected scope has no Squash case ids');
    return {
      caseIds,
      kind: 'selected',
      mode: 'selected',
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
  }

  private async collection(input: RegressionScopeInput): Promise<RegressionScopeResult> {
    const key = text(input.collectionKey);
    if (!key) throw new PlatformError('validation', 'A platform collectionKey is required (for example smoke).');

    // Explicit ids win (operator override / tests); E4 will own curated membership.
    const override = uniqueCaseIds(input.caseIds ?? []);
    if (override.length > 0) {
      return {
        caseIds: override,
        kind: 'collection',
        mode: 'regression-collection',
        collectionKey: key,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      };
    }

    if (!this.deps.collections) {
      throw new PlatformError(
        'denied',
        `Platform collection "${key}" lookup is not wired on this process (E4 curated smoke). Pass caseIds to preview, or run configure-scope on the worker.`,
      );
    }
    const found = await this.deps.collections.caseIdsForCollectionKey(key);
    if (found === undefined) {
      throw new PlatformError(
        'not-found',
        `Platform collection "${key}" was not found. Create it under Test Cases or wait for E4 curated smoke.`,
      );
    }
    const caseIds = uniqueCaseIds(found);
    if (caseIds.length === 0) {
      emptyScopeError(`Platform collection "${key}" has no Squash-mapped members`);
    }
    return {
      caseIds,
      kind: 'collection',
      mode: 'regression-collection',
      collectionKey: key,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
  }

  private async suite(input: RegressionScopeInput): Promise<RegressionScopeResult> {
    const override = uniqueCaseIds(input.caseIds ?? []);
    if (override.length > 0) {
      return {
        caseIds: override,
        kind: 'suite',
        mode: 'all-in-suite',
        projectId: text(input.projectId) || undefined,
        suiteId: text(input.suiteId) || undefined,
      };
    }

    const projectId = requireProject(input.projectId);
    const suiteId = text(input.suiteId) || undefined;
    const squash = this.requireSquash();

    if (suiteId) {
      const suiteSupport = await squash.probeSupport('tm.suite.list');
      if (suiteSupport === 'unsupported') {
        throw new PlatformError(
          'unsupported',
          'Squash suite listing is not available for this connector (probe: tm.suite.list unsupported). Omit suiteId to use all project test cases, or use campaign / collection scope.',
        );
      }
      throw new PlatformError(
        'unsupported',
        'Squash suite-filtered case listing is not implemented yet. Omit suiteId for all project cases, or use campaign / collection scope.',
      );
    }

    const listSupport = await squash.probeSupport('tm.testcase.list');
    if (listSupport === 'unsupported') {
      throw new PlatformError(
        'unsupported',
        'Squash test-case listing is not available for this connector (probe: tm.testcase.list unsupported).',
      );
    }

    const caseIds = uniqueCaseIds(await squash.listProjectCaseIds(projectId));
    if (caseIds.length === 0) emptyScopeError(`Squash project ${projectId} has no test cases`);
    return {
      caseIds,
      kind: 'suite',
      mode: 'all-in-suite',
      projectId,
    };
  }

  private async campaign(input: RegressionScopeInput): Promise<RegressionScopeResult> {
    const override = uniqueCaseIds(input.caseIds ?? []);
    if (override.length > 0) {
      return {
        caseIds: override,
        kind: 'campaign',
        mode: 'campaign',
        projectId: text(input.projectId) || undefined,
        campaignId: text(input.campaignId) || undefined,
        iterationId: text(input.iterationId) || undefined,
      };
    }

    const projectId = requireProject(input.projectId);
    const campaignId = text(input.campaignId);
    if (!campaignId) throw new PlatformError('validation', 'A Squash campaign id is required for campaign scope.');
    const iterationId = text(input.iterationId) || undefined;
    const squash = this.requireSquash();

    const campaignSupport = await squash.probeSupport('tm.campaign.list');
    if (campaignSupport === 'unsupported') {
      throw new PlatformError(
        'unsupported',
        'Squash campaign listing is not available for this connector (probe: tm.campaign.list unsupported).',
      );
    }
    const planSupport = await squash.probeSupport('tm.iteration.testplan.list');
    if (planSupport === 'unsupported') {
      throw new PlatformError(
        'unsupported',
        'Squash iteration test-plan listing is not available for this connector (probe: tm.iteration.testplan.list unsupported).',
      );
    }

    const caseIds = uniqueCaseIds(await squash.listCampaignCaseIds({ projectId, campaignId, iterationId }));
    if (caseIds.length === 0) {
      emptyScopeError(
        iterationId
          ? `Squash campaign ${campaignId} iteration ${iterationId} has no test-plan cases`
          : `Squash campaign ${campaignId} has no test-plan cases`,
      );
    }
    return {
      caseIds,
      kind: 'campaign',
      mode: 'campaign',
      projectId,
      campaignId,
      ...(iterationId ? { iterationId } : {}),
    };
  }

  private requireSquash(): RegressionScopeSquashPort {
    if (!this.deps.squash) {
      throw new PlatformError(
        'denied',
        'Squash suite/campaign scope needs the test-management connector on the worker (or a scope squash port on the API).',
      );
    }
    return this.deps.squash;
  }
}

/** Map platform collection members → Squash case ids via automation asset.testCaseId + mapping. */
export async function caseIdsFromPlatformCollection(deps: {
  collectionKey: string;
  listCollections: () => Promise<Array<{ id: string; name: string }>>;
  getCollection: (id: string) => Promise<{ cases: Array<{ id: string }> } | undefined>;
  listAssets: () => Promise<Array<{ id: string; testCaseId?: string }>>;
  listMappings: () => Promise<Array<{ assetId: string; squashCaseId: string }>>;
}): Promise<string[] | undefined> {
  const key = deps.collectionKey.trim().toLowerCase();
  if (!key) return undefined;
  const collections = await deps.listCollections();
  const match = collections.find((c) => c.name.trim().toLowerCase() === key);
  if (!match) return undefined;
  const detail = await deps.getCollection(match.id);
  if (!detail) return undefined;
  const assets = await deps.listAssets();
  const mappings = await deps.listMappings();
  const assetByTestCase = new Map(
    assets.filter((a) => a.testCaseId).map((a) => [a.testCaseId!, a.id] as const),
  );
  const squashByAsset = new Map(mappings.map((m) => [m.assetId, m.squashCaseId] as const));
  const out: string[] = [];
  for (const row of detail.cases) {
    const assetId = assetByTestCase.get(row.id);
    if (!assetId) continue;
    const squashCaseId = squashByAsset.get(assetId);
    if (squashCaseId) out.push(squashCaseId);
  }
  return uniqueCaseIds(out);
}
