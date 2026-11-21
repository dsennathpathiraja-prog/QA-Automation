import { MAX_GENERATED_CASES, MAX_PLAN_SCENARIOS } from './limits';
import { planArtifactPath, renderPlanMarkdown } from './plan-markdown';
import type { GeneratedPlaywrightCase, GenerateRequest, GenerateResult, PlanRequest, PlanResult, PlannerScenario, ScenarioKind, ScenarioPriority } from './types';

export const PLAYWRIGHT_TEST_PLANNER = 'playwright-test-planner';
export const PLAYWRIGHT_TEST_GENERATOR = 'playwright-test-generator';
export const PLAYWRIGHT_TEST_HEALER = 'playwright-test-healer';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'case';
const clip = (value: string, max: number) => value.trim().slice(0, max);

const priorityFor = (kind: ScenarioKind): ScenarioPriority => {
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

const caseTitle = (kind: ScenarioKind, label: string): string => {
  const line = clip(label, 90);
  if (kind === 'negative') return clip(`Negative: ${line}`, 120);
  if (kind === 'edge') return clip(`Edge: ${line}`, 120);
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

function negativeHints(criterion: string): string[] {
  const c = criterion.toLowerCase();
  if (/login|sign.?in|password|auth/i.test(c)) {
    return ['wrong password', 'locked account', 'missing credentials', 'expired session'];
  }
  if (/pay|card|checkout|payment/i.test(c)) {
    return ['declined card', 'missing CVV', 'unsupported currency', 'network timeout at authorize'];
  }
  if (/upload|file|attach/i.test(c)) {
    return ['unsupported file type', 'oversize payload', 'empty file', 'malware-flagged file'];
  }
  if (/search|filter|list/i.test(c)) {
    return ['empty query', 'unknown filter', 'no matching rows', 'SQL-like injection string'];
  }
  if (/email|notify|message/i.test(c)) {
    return ['malformed address', 'suppressed notification preference', 'duplicate send'];
  }
  const focus = focusOf(criterion);
  return [
    `invalid input for "${focus}"`,
    `unauthorized access for "${focus}"`,
    `missing required field for "${focus}"`,
  ];
}

function edgeHints(criterion: string): string[] {
  const c = criterion.toLowerCase();
  if (/total|tax|amount|price|count/i.test(c)) {
    return ['zero amount', 'maximum amount', 'rounding at currency boundaries', 'negative amount rejected'];
  }
  if (/pay|card|checkout|payment/i.test(c)) {
    return ['single saved card', 'many cards on file', 'expired card on file', 'card brand not accepted'];
  }
  if (/\blists?\b|\bpages?\b|scroll|\btables?\b/i.test(c)) {
    return ['empty list', 'single row', 'last-page pagination', 'very long row label'];
  }
  if (/date|time|schedule/i.test(c)) {
    return ['same-day', 'timezone edge', 'expired window', 'far-future date'];
  }
  if (/name|text|title|description/i.test(c)) {
    return ['empty string', 'maximum length', 'unicode characters', 'leading/trailing whitespace'];
  }
  const focus = focusOf(criterion);
  return [
    `minimum boundary for "${focus}"`,
    `maximum boundary for "${focus}"`,
    `alternate path around "${focus}"`,
  ];
}

function positiveHints(criterion: string): string[] {
  const focus = focusOf(criterion);
  return [
    `happy path for ${focus}`,
    `repeat successful path for ${focus}`,
    `confirm persistence after refresh for ${focus}`,
  ];
}

/** Extra path seeds from Description body (beyond AC bullets). */
export function descriptionPathSeeds(story: string, criteria: string[]): string[] {
  const criteriaSet = new Set(criteria.map((c) => c.toLowerCase()));
  const lines = story.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const seeds: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^[\s>*\-•\d.)]+/, '').trim();
    if (!line || line.length < 12) continue;
    if (/^(#{1,6}\s|acceptance criteria\b|repro(duction)? steps\b|description\b|notes?\b)/i.test(line)) continue;
    if (/^\d{1,10}$/.test(line) || /^[A-Z][A-Z0-9]+-\d+$/i.test(line)) continue;
    if (criteriaSet.has(line.toLowerCase())) continue;
    if (/^(given|when|then|and)\b/i.test(line)) continue;
    seeds.push(clip(line, 160));
    if (seeds.length >= 40) break;
  }
  return seeds;
}

function pushScenario(
  scenarios: PlannerScenario[],
  kind: ScenarioKind,
  criterion: string,
  label: string,
  steps: string,
  expected: string,
): void {
  if (scenarios.length >= MAX_PLAN_SCENARIOS) return;
  scenarios.push({
    name: caseTitle(kind, label),
    kind,
    priority: priorityFor(kind),
    criterion: clip(criterion, 160),
    steps,
    expected,
  });
}

/**
 * Description-aware heuristic planner (in-repo stand-in for playwright-test-planner).
 * Emits multiple Positive / Negative / Edge scenarios per acceptance criterion and
 * Description path — not a single sparse triple. Prefer the LLM / MCP planner when configured.
 */
export function planHeuristically(input: PlanRequest): PlanResult {
  const criteria = input.criteria.length > 0 ? input.criteria : [`Verify ${input.application} for ${input.workItem}`];
  const pathSeeds = descriptionPathSeeds(input.story, criteria);
  const seeds = [...criteria, ...pathSeeds.filter((s) => !criteria.includes(s))];
  const scenarios: PlannerScenario[] = [];

  for (const criterion of seeds) {
    const line = clip(criterion, 160);
    for (const hint of positiveHints(line)) {
      pushScenario(
        scenarios,
        'positive',
        line,
        hint,
        [
          `Open ${input.application}.`,
          `Locate the UI for: ${focusOf(line)}.`,
          `Complete ${hint}.`,
          `Confirm the outcome matches: ${clip(line, 160)}.`,
        ].join(' '),
        `${clip(line, 140)} succeeds with the expected result visible to the user (${hint}).`,
      );
    }
    for (const hint of negativeHints(line)) {
      pushScenario(
        scenarios,
        'negative',
        line,
        `reject ${hint}`,
        [
          `Open ${input.application}.`,
          `Attempt ${hint}.`,
          `Do not complete the happy path for: ${focusOf(line)}.`,
          'Observe the blocked or error state without forcing a bypass.',
        ].join(' '),
        `The invalid path (${hint}) is refused with a clear error or blocked state; "${focusOf(line)}" does not succeed.`,
      );
    }
    for (const hint of edgeHints(line)) {
      pushScenario(
        scenarios,
        'edge',
        line,
        hint,
        [
          `Open ${input.application}.`,
          `Exercise ${hint}.`,
          `Keep the acceptance criterion in view: ${clip(line, 120)}.`,
        ].join(' '),
        `The criterion still holds at the boundary (${hint}).`,
      );
    }
    if (scenarios.length >= MAX_PLAN_SCENARIOS) break;
  }

  const sliced = scenarios.slice(0, MAX_PLAN_SCENARIOS);
  const planMarkdown = renderPlanMarkdown(sliced, {
    workItem: input.workItem,
    application: input.application,
    criteria: input.criteria,
    findings: input.findings,
    source: 'heuristic',
  });
  const planArtifact = planArtifactPath(input.workItem, input.application);
  return {
    summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${sliced.length} scenario${sliced.length === 1 ? '' : 's'} for ${input.workItem} from the story (no model). Plan artifact ${planArtifact}.`,
    scenarios: sliced,
    planMarkdown,
    planArtifact,
    source: 'heuristic',
  };
}

/**
 * Heuristic generator (in-repo stand-in for playwright-test-generator).
 * Consumes planned scenarios (from the MD plan) and embeds exploration findings.
 */
export function generateHeuristically(input: GenerateRequest): GenerateResult {
  const application = slug(input.application);
  const work = slug(input.workItem);
  const findingsNote = (input.findings ?? '').trim();
  const cases: GeneratedPlaywrightCase[] = input.scenarios.slice(0, MAX_GENERATED_CASES).map((scenario, index) => {
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
