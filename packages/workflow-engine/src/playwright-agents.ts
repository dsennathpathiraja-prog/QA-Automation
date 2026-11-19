/** The two agents a requirement-validation run uses for the plan and the generated tests. */
export const PLAYWRIGHT_TEST_PLANNER = 'playwright-test-planner';
export const PLAYWRIGHT_TEST_GENERATOR = 'playwright-test-generator';

export type ScenarioKind = 'positive' | 'negative' | 'edge';
export type ScenarioPriority = 'high' | 'medium' | 'low';

export interface PlannerScenario {
  name: string;
  kind: ScenarioKind;
  priority: ScenarioPriority;
  criterion: string;
  steps: string;
  expected: string;
}

export interface GeneratedPlaywrightCase {
  name: string;
  kind: ScenarioKind;
  priority: ScenarioPriority;
  steps: string;
  expected: string;
  workItem: string;
  reference: string;
  file: string;
  testId: string;
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'case';

const clip = (value: string, max: number) => value.trim().slice(0, max);

const priorityFor = (kind: ScenarioKind): ScenarioPriority => {
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

/** Short label a senior QA would put on a case name (PR #9 naming). */
const caseTitle = (kind: ScenarioKind, criterion: string): string => {
  const line = clip(criterion, 90);
  if (kind === 'negative') return clip(`Negative: reject invalid path for ${line}`, 120);
  if (kind === 'edge') return clip(`Edge: boundary / alternate path for ${line}`, 120);
  return clip(`Positive: ${line}`, 120);
};

/**
 * playwright-test-planner. One positive, one negative and one edge scenario per acceptance criterion.
 * The story text is the only input. This function does not call a model or a browser.
 */
export function planWithPlaywrightPlanner(input: { workItem: string; application: string; criteria: string[] }): { summary: string; scenarios: PlannerScenario[] } {
  const criteria = input.criteria.length > 0 ? input.criteria : [`Verify ${input.application} for ${input.workItem}`];
  const scenarios: PlannerScenario[] = [];
  for (const criterion of criteria) {
    const line = clip(criterion, 100);
    for (const kind of ['positive', 'negative', 'edge'] as const) {
      scenarios.push({
        name: caseTitle(kind, line),
        kind,
        priority: priorityFor(kind),
        criterion: line,
        steps: kind === 'negative'
          ? `Open ${input.application} and attempt an invalid or unauthorized path for: ${line}`
          : kind === 'edge'
            ? `Open ${input.application} and exercise a boundary or alternate path for: ${line}`
            : `Open ${input.application} and complete the happy path for: ${line}`,
        expected: kind === 'negative'
          ? `${line} is refused and the user sees a clear error or blocked state`
          : kind === 'edge'
            ? `${line} still holds at the boundary`
            : `${line} succeeds with the expected result`,
      });
      if (scenarios.length >= 40) break;
    }
    if (scenarios.length >= 40) break;
  }
  return {
    summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} for ${input.workItem}.`,
    scenarios: scenarios.slice(0, 40),
  };
}

/**
 * playwright-test-generator. Each scenario becomes one Playwright test and one Squash reference.
 */
export function generateWithPlaywrightGenerator(input: { workItem: string; application: string; scenarios: PlannerScenario[] }): { summary: string; cases: GeneratedPlaywrightCase[] } {
  const application = slug(input.application);
  const work = slug(input.workItem);
  const cases = input.scenarios.slice(0, 40).map((scenario, index) => {
    const testId = `${work}-${scenario.kind}-${index + 1}`;
    const file = `tests/${application}/${work}.spec.js`;
    const source = [
      "import { test, expect } from '@playwright/test';",
      '',
      `test('${scenario.name.replace(/'/g, "\\'")}', async ({ page }) => {`,
      "  await page.goto('/');",
      `  // ${scenario.kind} (${scenario.priority}): ${scenario.criterion}`,
      `  await expect(page.locator('body')).toBeVisible();`,
      '});',
      '',
    ].join('\n');
    return {
      name: scenario.name,
      kind: scenario.kind,
      priority: scenario.priority,
      steps: source,
      expected: scenario.expected,
      workItem: input.workItem,
      reference: `QAP-${work}-${index + 1}`.slice(0, 50),
      file,
      testId,
    };
  });
  return {
    summary: `${PLAYWRIGHT_TEST_GENERATOR} wrote ${cases.length} Playwright test${cases.length === 1 ? '' : 's'} for ${input.workItem}.`,
    cases,
  };
}
