import {
  assertPublishQualityGate,
  isNeedsSurfaceCase,
  NEEDS_SURFACE_TAG,
  toSquashUpsertInput,
  type CaseKind,
  type CasePriority,
  type CaseQualityReport,
  type PlannerScenario,
  type SurfaceKind,
  type ValidationStep,
} from '@qa/agents';
import { PlatformError } from '@qa/domain';
import type { AutomationService, TestCaseService } from '@qa/application';

/** Generated case shape after publish mapping (matches the case template). */
export interface GeneratedCase {
  name: string;
  steps: string;
  expected: string;
  workItem: string;
  reference: string;
  kind?: CaseKind;
  priority?: CasePriority;
  validationSteps?: ValidationStep[];
  file?: string;
  runStatus?: 'Blocked' | 'Skipped';
  tags?: string[];
  primarySurfaceUrl?: string;
  surfaceKind?: SurfaceKind;
}

interface SquashResult {
  id: string;
  created: boolean;
  projectId?: string;
}

/**
 * Saves each generated case in Test Cases and, when a Squash connector is bound, stores it there
 * with a meaningful name, automated_test_reference, description, and action steps.
 * A repeated reference is kept as the same Squash case (PATCH + replace steps).
 * Body-only / stub cases are refused by the case quality gate (Phase 8 E3).
 */
export async function publishGeneratedCases(input: {
  workItem: string;
  cases: GeneratedCase[];
  testCases: TestCaseService;
  squash?: (item: GeneratedCase, upsert: ReturnType<typeof toSquashUpsertInput>) => Promise<SquashResult>;
  /** When set, each Squash-stored case seeds a draft automation asset + Squash↔script mapping (Phase 8 E6). */
  automation?: AutomationService;
  /** Acceptance criteria for AC coverage warnings (from Read story / plan). */
  criteria?: string[];
  scenarios?: PlannerScenario[];
  planMarkdown?: string;
  blockingGap?: boolean;
}): Promise<{ summary: string; quality?: CaseQualityReport }> {
  const workItem = input.workItem || 'work-item';
  if (input.cases.length === 0) return { summary: `No test cases were generated for ${workItem}. Nothing was sent to Squash.` };
  const quality = assertPublishQualityGate({
    cases: input.cases,
    criteria: input.criteria,
    scenarios: input.scenarios,
    planMarkdown: input.planMarkdown,
    blockingGap: input.blockingGap,
  });
  const squashIds: string[] = [];
  const references: string[] = [];
  let projectId = '';
  let squashError = '';
  let needsSurfaceCount = 0;
  let mapped = 0;
  for (const item of input.cases) {
    let squashId = '';
    const needsSurface = item.runStatus === 'Blocked'
      || item.tags?.includes(NEEDS_SURFACE_TAG)
      || isNeedsSurfaceCase(item);
    if (needsSurface) needsSurfaceCount += 1;
    const upsert = toSquashUpsertInput({
      name: item.name,
      kind: item.kind,
      priority: item.priority,
      steps: item.steps,
      expected: item.expected,
      validationSteps: item.validationSteps,
      workItem: item.workItem || workItem,
      reference: item.reference,
      file: item.file,
    });
    if (input.squash && !squashError) {
      try {
        const saved = await input.squash(item, upsert);
        squashId = saved.id;
        squashIds.push(saved.id);
        references.push(item.reference);
        if (!projectId && saved.projectId) projectId = saved.projectId;
      } catch (e) {
        squashError = e instanceof PlatformError ? e.message : 'Squash did not accept the test case.';
        if (/not bound/i.test(squashError)) {
          squashError = 'No Squash connector is bound on this workflow run. On the workflow Connectors tab choose Squash, then republish and run again.';
        } else if (/read-only/i.test(squashError) && !/token is READ-only/i.test(squashError) && !/READ_WRITE/i.test(squashError)) {
          squashError = 'The Squash connector is still read-only. Rebuild so migration 0010 applies, or recreate the connector, then Switch on and run again.';
        }
      }
    }
    const gapSummary = needsSurface
      ? `[${NEEDS_SURFACE_TAG}] Blocked — explore surface gap${item.surfaceKind ? ` (expected ${item.surfaceKind})` : ''}${item.primarySurfaceUrl ? `; primary ${item.primarySurfaceUrl}` : ''}`
      : '';
    const baseSummary = squashId ? `Squash ${squashId}` : item.reference;
    const filed = await input.testCases.fileUnderWorkItem(
      { id: 'worker' },
      {
        name: upsert.name,
        steps: item.steps,
        expected: item.expected,
        workItem: item.workItem || workItem,
        reference: item.reference,
        summary: gapSummary ? `${gapSummary}. ${baseSummary}`.slice(0, 500) : baseSummary,
        kind: item.kind,
        priority: item.priority,
      },
    );
    if (input.automation && squashId) {
      try {
        await input.automation.seedFromPublish(
          { id: 'worker' },
          {
            key: item.reference,
            name: upsert.name,
            scriptPath: item.file || `tests/generated/${item.reference}.spec.js`,
            scriptBody: item.steps,
            testCaseId: filed.id,
            squashCaseId: squashId,
            squashReference: item.reference,
          },
        );
        mapped += 1;
      } catch {
        // Mapping seed must not fail publish; resolve stays empty until register/approve via API.
      }
    }
  }
  const count = input.cases.length;
  const noun = `test case${count === 1 ? '' : 's'}`;
  const gapNote = needsSurfaceCount > 0
    ? ` ${needsSurfaceCount} marked Blocked (${NEEDS_SURFACE_TAG}) for explore surface gap.`
    : '';
  const acGaps = quality.acCoverage.filter((r) => !r.covered).length;
  const coverageNote = acGaps > 0
    ? ` Quality gate: ${acGaps} AC coverage gap${acGaps === 1 ? '' : 's'} flagged (publish allowed).`
    : ' Quality gate: ok.';
  const mapNote = mapped > 0 ? ` Seeded ${mapped} draft automation mapping${mapped === 1 ? '' : 's'}.` : '';
  const kept = `Stored ${count} ${noun} for ${workItem} under that work item${gapNote}${coverageNote}${mapNote}`;
  if (!input.squash) return { summary: `${kept} in Test Cases. No Squash connector is selected on this workflow.`, quality };
  if (squashError && squashIds.length === 0) return { summary: `${kept} in Test Cases. Squash did not store them: ${squashError}`, quality };
  if (squashError) return { summary: `${kept} in Test Cases. Squash stored ${squashIds.length} and then stopped: ${squashError}`, quality };
  const where = projectId ? `Squash project ${projectId}` : 'Squash';
  const refs = references.length > 0 ? ` References: ${references.join(', ')}. Squash ids: ${squashIds.join(', ')}.` : '';
  return { summary: `${kept} in Test Cases and in ${where}.${refs}`, quality };
}
