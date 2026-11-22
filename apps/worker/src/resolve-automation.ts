import type { AutomationService, RegressionResolveResult } from '@qa/application';
import { uniqueCaseIds } from '@qa/application';
import { PlatformError } from '@qa/domain';

export type FlowResult = { summary: string; outputs: Record<string, unknown> };

const asStringList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return uniqueCaseIds(raw.map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : '')));
  }
  if (typeof raw === 'string') {
    return uniqueCaseIds(raw.split(/[\s,;]+/));
  }
  return [];
};

const caseIdsFromScope = (scope: unknown): string[] => {
  if (!scope || typeof scope !== 'object') return [];
  const row = scope as Record<string, unknown>;
  return asStringList(row.caseIds ?? row.squashCaseIds ?? row.cases ?? row.selectedCaseIds);
};

/**
 * Collect Squash case ids for `rg.resolve-automation`.
 * Prefers explicit run params, then configure_scope outputs (E3 will fill scope).
 */
export function squashCaseIdsForResolve(step: {
  params: Record<string, unknown>;
  prior: Record<string, Record<string, unknown>>;
}): string[] {
  const fromParams = asStringList(step.params.squashCaseIds ?? step.params.caseIds);
  if (fromParams.length > 0) return fromParams;

  const configure = step.prior.configure_scope ?? {};
  const fromConfigureScope = caseIdsFromScope(configure.scope);
  if (fromConfigureScope.length > 0) return fromConfigureScope;
  const fromConfigure = caseIdsFromScope(configure);
  if (fromConfigure.length > 0) return fromConfigure;

  const selection = step.params.selection;
  if (selection && typeof selection === 'object') {
    const fromSelection = caseIdsFromScope(selection);
    if (fromSelection.length > 0) return fromSelection;
  }

  return [];
}

export function summarizeRegressionResolve(result: RegressionResolveResult): string {
  const approved = result.resolved.length;
  const skipped = result.notAutomated.length;
  if (approved === 0 && skipped === 0) {
    return 'No Squash case ids in scope — nothing to resolve for Regression.';
  }
  const reasons = result.notAutomated.reduce<Record<string, number>>((acc, row) => {
    acc[row.reason] = (acc[row.reason] ?? 0) + 1;
    return acc;
  }, {});
  const reasonPart = skipped > 0
    ? ` Not Automated: ${skipped} (${Object.entries(reasons).map(([k, n]) => `${k}=${n}`).join(', ')}).`
    : '';
  return `Resolved ${approved} approved automation asset${approved === 1 ? '' : 's'} for Regression.${reasonPart} No generation or explore.`;
}

/**
 * Phase 9 E1 — `rg.resolve-automation`: approved-only against automation_mapping + automation_asset.
 * Draft / missing → Not Automated; never generates cases or opens explore connectors.
 */
export async function performResolveAutomation(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  automation: AutomationService | undefined,
): Promise<FlowResult> {
  if (step.type !== 'rg.resolve-automation') {
    throw new PlatformError('internal', `performResolveAutomation does not handle ${step.type}`);
  }
  if (!automation) {
    throw new PlatformError('denied', 'Regression resolve requires the automation mapping service on the worker.');
  }

  const squashCaseIds = squashCaseIdsForResolve(step);
  if (squashCaseIds.length === 0) {
    return {
      summary: 'No Squash case ids in scope — nothing to resolve for Regression.',
      outputs: { resolved: [], notAutomated: [] },
    };
  }

  const result = await automation.resolveForRegression(squashCaseIds);
  return {
    summary: summarizeRegressionResolve(result),
    outputs: {
      resolved: result.resolved,
      notAutomated: result.notAutomated,
    },
  };
}
