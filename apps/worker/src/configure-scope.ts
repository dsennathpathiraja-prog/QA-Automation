import {
  parseRegressionScopeInput,
  RegressionScopeService,
  type RegressionScopeCollectionPort,
  type RegressionScopeResult,
  type RegressionScopeSquashPort,
  type ScopeCapability,
  type ScopeSupport,
  uniqueCaseIds,
} from '@qa/application';
import { PlatformError } from '@qa/domain';

export type FlowResult = { summary: string; outputs: Record<string, unknown> };

export type SquashInvoker = (capability: string, input: Record<string, unknown>) => Promise<unknown>;

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined);

const text = (raw: unknown): string =>
  (typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '');

async function collectItems(
  invoke: SquashInvoker,
  capability: string,
  baseInput: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const raw = await invoke(capability, { ...baseInput, ...(cursor ? { cursor } : {}), limit: 200 });
    const row = asRecord(raw) ?? {};
    const items = Array.isArray(row.items) ? row.items : [];
    for (const item of items) {
      if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
    }
    const next = text(row.nextCursor);
    if (!next) break;
    cursor = next;
  }
  return out;
}

/** Build a Squash port for Regression scope from ConnectorExecutionManager.invoke. */
export function squashPortFromInvoker(invoke: SquashInvoker): RegressionScopeSquashPort {
  return {
    async probeSupport(capability: ScopeCapability): Promise<ScopeSupport> {
      try {
        const raw = await invoke('tm.capabilities.probe', {});
        const caps = Array.isArray(asRecord(raw)?.capabilities) ? (asRecord(raw)!.capabilities as unknown[]) : [];
        const hit = caps.find((c) => asRecord(c)?.capability === capability);
        const support = text(asRecord(hit)?.support);
        if (support === 'supported' || support === 'partial' || support === 'unsupported') return support;
      } catch {
        /* fall through */
      }
      // Conservative defaults when probe fails mid-run.
      if (capability === 'tm.suite.list') return 'unsupported';
      if (capability === 'tm.iteration.testplan.list') return 'supported';
      return 'supported';
    },

    async listProjectCaseIds(projectId: string): Promise<string[]> {
      const items = await collectItems(invoke, 'tm.testcase.list', { project: projectId });
      return uniqueCaseIds(items.map((item) => text(item.id)));
    },

    async listCampaignCaseIds(input: { projectId: string; campaignId: string; iterationId?: string }): Promise<string[]> {
      let iterationIds: string[];
      if (input.iterationId) {
        iterationIds = [input.iterationId];
      } else {
        const iterations = await collectItems(invoke, 'tm.iteration.list', {
          project: input.projectId,
          campaign: input.campaignId,
        });
        iterationIds = uniqueCaseIds(iterations.map((item) => text(item.id)));
      }
      const caseIds: string[] = [];
      for (const iteration of iterationIds) {
        const plan = await collectItems(invoke, 'tm.iteration.testplan.list', {
          project: input.projectId,
          iteration,
        });
        for (const item of plan) {
          const id = text(item.testCaseId) || text(asRecord(item.test_case)?.id) || text(asRecord(item.testCase)?.id);
          if (id) caseIds.push(id);
        }
      }
      return uniqueCaseIds(caseIds);
    },
  };
}

export function summarizeRegressionScope(result: RegressionScopeResult): string {
  const n = result.caseIds.length;
  const where = result.kind === 'collection'
    ? `collection "${result.collectionKey}"`
    : result.kind === 'campaign'
      ? `campaign ${result.campaignId}${result.iterationId ? ` / iteration ${result.iterationId}` : ''}`
      : result.kind === 'suite'
        ? `project ${result.projectId}${result.suiteId ? ` / suite ${result.suiteId}` : ''}`
        : 'selected cases';
  return `Configured Regression scope (${result.mode}): ${n} Squash case id${n === 1 ? '' : 's'} from ${where}.`;
}

/**
 * Phase 9 E3 — `rg.select-squash-project`: record the Squash project from run params.
 */
export async function performSelectSquashProject(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
): Promise<FlowResult> {
  if (step.type !== 'rg.select-squash-project') {
    throw new PlatformError('internal', `performSelectSquashProject does not handle ${step.type}`);
  }
  const parsed = parseRegressionScopeInput({
    squashScope: step.params.squashScope ?? step.params.scope,
    selection: step.params.selection,
    projectId: step.params.projectId,
    ...step.params,
  });
  const projectId = text(parsed.projectId);
  if (!projectId && parsed.kind !== 'collection' && parsed.kind !== 'selected') {
    throw new PlatformError('validation', 'Regression needs a Squash project id in squashScope (or selected/collection scope).');
  }
  return {
    summary: projectId
      ? `Selected Squash project ${projectId} for Regression scope.`
      : `No Squash project required for ${parsed.kind} scope.`,
    outputs: {
      projectId: projectId || null,
      kind: parsed.kind,
      candidates: [],
    },
  };
}

/**
 * Phase 9 E3 — `rg.configure-scope`: expand suite / campaign / collection / selected → case ids for resolve.
 */
export async function performConfigureScope(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  deps: {
    squash?: RegressionScopeSquashPort;
    collections?: RegressionScopeCollectionPort;
    /** Step config from the template (mode / collectionKey). */
    config?: Record<string, unknown>;
  },
): Promise<FlowResult> {
  if (step.type !== 'rg.configure-scope') {
    throw new PlatformError('internal', `performConfigureScope does not handle ${step.type}`);
  }

  const priorProject = step.prior.select_project ?? {};
  const input = parseRegressionScopeInput({
    ...step.params,
    squashScope: step.params.squashScope ?? step.params.scope,
    selection: step.params.selection,
    config: deps.config ?? asRecord(step.params.config) ?? {},
    projectId: text(step.params.projectId) || text(priorProject.projectId),
  });

  // Prefer project id from select_project when the wizard only sent selection.
  if (!input.projectId && text(priorProject.projectId)) {
    input.projectId = text(priorProject.projectId);
  }

  const service = new RegressionScopeService({
    squash: deps.squash,
    collections: deps.collections,
  });
  const result = await service.resolve(input);
  return {
    summary: summarizeRegressionScope(result),
    outputs: {
      scope: result,
      caseIds: result.caseIds,
      mode: result.mode,
      kind: result.kind,
    },
  };
}
