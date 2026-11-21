import type { GeneratedPlaywrightCase, GenerateRequest, GenerateResult, PlanRequest, PlanResult, PlannerScenario, ScenarioKind, ScenarioPriority } from './types';

export const PLAYWRIGHT_TEST_PLANNER = 'playwright-test-planner';
export const PLAYWRIGHT_TEST_GENERATOR = 'playwright-test-generator';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'case';
const clip = (value: string, max: number) => value.trim().slice(0, max);

const priorityFor = (kind: ScenarioKind): ScenarioPriority => {
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

const caseTitle = (kind: ScenarioKind, criterion: string): string => {
  const line = clip(criterion, 90);
  if (kind === 'negative') return clip(`Negative: reject invalid path for ${line}`, 120);
  if (kind === 'edge') return clip(`Edge: boundary / alternate path for ${line}`, 120);
  return clip(`Positive: ${line}`, 120);
};

/** Pull actionable nouns from a criterion so steps are not identical boilerplate. */
function focusOf(criterion: string): string {
  const cleaned = criterion
    .replace(/^(given|when|then|and)\b/gi, '')
    .replace(/\b(the|a|an|user|shopper|system|should|must|can|will)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(cleaned || criterion, 80);
}

function negativeHint(criterion: string): string {
  const c = criterion.toLowerCase();
  if (/login|sign.?in|password|auth/i.test(c)) return 'wrong password, locked account, or missing credentials';
  if (/pay|card|checkout|payment/i.test(c)) return 'declined card, missing CVV, or unsupported currency';
  if (/upload|file|attach/i.test(c)) return 'unsupported file type or oversize payload';
  if (/search|filter|list/i.test(c)) return 'empty query, unknown filter, or no matching rows';
  if (/email|notify|message/i.test(c)) return 'malformed address or suppressed notification preference';
  return `invalid or unauthorized input for "${focusOf(criterion)}"`;
}

function edgeHint(criterion: string): string {
  const c = criterion.toLowerCase();
  if (/total|tax|amount|price|count/i.test(c)) return 'zero amount, maximum amount, and rounding at currency boundaries';
  if (/pay|card|checkout|payment/i.test(c)) return 'single saved card, many cards, and an expired card on file';
  if (/\blists?\b|\bpages?\b|scroll|\btables?\b/i.test(c)) return 'empty list, single row, and last-page pagination';
  if (/date|time|schedule/i.test(c)) return 'same-day, timezone edge, and expired window';
  if (/name|text|title|description/i.test(c)) return 'empty string, maximum length, and unicode characters';
  return `boundary and alternate path around "${focusOf(criterion)}"`;
}

function positiveSteps(application: string, criterion: string): string {
  return [
    `Open ${application}.`,
    `Locate the UI for: ${focusOf(criterion)}.`,
    `Complete the happy path described by the acceptance criterion.`,
    `Confirm the outcome matches: ${clip(criterion, 160)}.`,
  ].join(' ');
}

function negativeSteps(application: string, criterion: string): string {
  return [
    `Open ${application}.`,
    `Attempt ${negativeHint(criterion)}.`,
    `Do not complete the happy path for: ${focusOf(criterion)}.`,
    'Observe the blocked or error state without forcing a bypass.',
  ].join(' ');
}

function edgeSteps(application: string, criterion: string): string {
  return [
    `Open ${application}.`,
    `Exercise ${edgeHint(criterion)}.`,
    `Keep the acceptance criterion in view: ${clip(criterion, 120)}.`,
  ].join(' ');
}

/**
 * Description-aware heuristic planner (in-repo stand-in for playwright-test-planner).
 * Prefer the LLM / MCP planner when configured; this path keeps runs useful offline.
 */
export function planHeuristically(input: PlanRequest): PlanResult {
  const criteria = input.criteria.length > 0 ? input.criteria : [`Verify ${input.application} for ${input.workItem}`];
  const scenarios: PlannerScenario[] = [];
  for (const criterion of criteria) {
    const line = clip(criterion, 160);
    for (const kind of ['positive', 'negative', 'edge'] as const) {
      scenarios.push({
        name: caseTitle(kind, line),
        kind,
        priority: priorityFor(kind),
        criterion: line,
        steps: kind === 'negative' ? negativeSteps(input.application, line) : kind === 'edge' ? edgeSteps(input.application, line) : positiveSteps(input.application, line),
        expected: kind === 'negative'
          ? `The invalid path is refused with a clear error or blocked state; "${focusOf(line)}" does not succeed.`
          : kind === 'edge'
            ? `The criterion still holds at the boundary (${edgeHint(line)}).`
            : `${clip(line, 140)} succeeds with the expected result visible to the user.`,
      });
      if (scenarios.length >= 40) break;
    }
    if (scenarios.length >= 40) break;
  }
  return {
    summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} for ${input.workItem} from the story (no model).`,
    scenarios: scenarios.slice(0, 40),
    source: 'heuristic',
  };
}

/**
 * Heuristic generator (in-repo stand-in for playwright-test-generator).
 * Embeds criterion and optional exploration findings into the Playwright stub.
 */
export function generateHeuristically(input: GenerateRequest): GenerateResult {
  const application = slug(input.application);
  const work = slug(input.workItem);
  const findingsNote = (input.findings ?? '').trim();
  const cases: GeneratedPlaywrightCase[] = input.scenarios.slice(0, 40).map((scenario, index) => {
    const testId = `${work}-${scenario.kind}-${index + 1}`;
    const file = `tests/${application}/${work}.spec.js`;
    const findingLine = findingsNote
      ? `  // Exploration: ${clip(findingsNote.replace(/\s+/g, ' '), 200)}`
      : '  // Exploration: none yet — bind Playwright browser and an environment to enrich selectors.';
    const source = [
      "import { test, expect } from '@playwright/test';",
      '',
      `test('${scenario.name.replace(/'/g, "\\'")}', async ({ page }) => {`,
      "  await page.goto('/');",
      `  // ${scenario.kind} (${scenario.priority}): ${scenario.criterion}`,
      `  // Steps: ${clip(scenario.steps.replace(/\s+/g, ' '), 220)}`,
      findingLine,
      "  await expect(page.locator('body')).toBeVisible();",
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
    summary: `${PLAYWRIGHT_TEST_GENERATOR} wrote ${cases.length} Playwright test${cases.length === 1 ? '' : 's'} for ${input.workItem} from the plan (no model).`,
    cases,
    source: 'heuristic',
  };
}
