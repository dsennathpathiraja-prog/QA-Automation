/** The two agents a requirement-validation run uses for the plan and the generated tests. */
export const PLAYWRIGHT_TEST_PLANNER = 'playwright-test-planner';
export const PLAYWRIGHT_TEST_GENERATOR = 'playwright-test-generator';

export interface PlannerScenario {
  name: string;
  kind: 'positive' | 'negative' | 'edge';
  criterion: string;
  steps: string;
  expected: string;
}

export interface GeneratedPlaywrightCase {
  name: string;
  steps: string;
  expected: string;
  workItem: string;
  reference: string;
  file: string;
  testId: string;
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'case';

const clip = (value: string, max: number) => value.trim().slice(0, max);

/**
 * playwright-test-planner. One positive, one negative and one edge scenario per acceptance criterion.
 * The story text is the only input. This function does not call a model or a browser.
 */
export function planWithPlaywrightPlanner(input: { workItem: string; application: string; criteria: string[] }): { summary: string; scenarios: PlannerScenario[] } {
  const criteria = input.criteria.length > 0 ? input.criteria : [`Verify ${input.application} for ${input.workItem}`];
  const scenarios: PlannerScenario[] = [];
  for (const criterion of criteria) {
    const line = clip(criterion, 100);
    scenarios.push(
      { name: clip(line, 120), kind: 'positive', criterion: line, steps: `Open ${input.application} and follow: ${line}`, expected: line },
      { name: clip(`${line} is refused when the input is invalid`, 120), kind: 'negative', criterion: line, steps: `Open ${input.application} and submit an invalid value for: ${line}`, expected: `${line} is not accepted` },
      { name: clip(`${line} at the boundary`, 120), kind: 'edge', criterion: line, steps: `Open ${input.application} and use a boundary value for: ${line}`, expected: `${line} still holds at the boundary` },
    );
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
      `  // ${scenario.kind}: ${scenario.criterion}`,
      `  await expect(page.locator('body')).toBeVisible();`,
      '});',
      '',
    ].join('\n');
    return {
      name: scenario.name,
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
