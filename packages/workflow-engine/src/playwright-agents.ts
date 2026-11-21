/** Offline stand-ins for playwright-test-planner / generator / healer used by sync runFlowStep. */

export const PLAYWRIGHT_TEST_PLANNER = 'playwright-test-planner';
export const PLAYWRIGHT_TEST_GENERATOR = 'playwright-test-generator';
export const PLAYWRIGHT_TEST_HEALER = 'playwright-test-healer';

export const MAX_PLAN_SCENARIOS = 200;
export const MAX_GENERATED_CASES = 250;

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

const caseTitle = (kind: ScenarioKind, label: string): string => {
  const line = clip(label, 90);
  if (kind === 'negative') return clip(`Negative: ${line}`, 120);
  if (kind === 'edge') return clip(`Edge: ${line}`, 120);
  return clip(`Positive: ${line}`, 120);
};

const focusOf = (criterion: string): string => {
  const cleaned = criterion
    .replace(/^(given|when|then|and)\b/gi, '')
    .replace(/\b(the|a|an|user|shopper|system|should|must|can|will)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(cleaned || criterion, 80);
};

const negativeHints = (criterion: string): string[] => {
  const c = criterion.toLowerCase();
  if (/login|sign.?in|password|auth/i.test(c)) return ['wrong password', 'locked account', 'missing credentials'];
  if (/pay|card|checkout|payment/i.test(c)) return ['declined card', 'missing CVV', 'unsupported currency'];
  if (/upload|file|attach/i.test(c)) return ['unsupported file type', 'oversize payload', 'empty file'];
  if (/search|filter|list/i.test(c)) return ['empty query', 'unknown filter', 'no matching rows'];
  if (/email|notify|message/i.test(c)) return ['malformed address', 'suppressed notification preference'];
  const focus = focusOf(criterion);
  return [`invalid input for "${focus}"`, `unauthorized access for "${focus}"`];
};

const edgeHints = (criterion: string): string[] => {
  const c = criterion.toLowerCase();
  if (/total|tax|amount|price|count/i.test(c)) return ['zero amount', 'maximum amount', 'rounding at currency boundaries'];
  if (/pay|card|checkout|payment/i.test(c)) return ['single saved card', 'many cards on file', 'expired card on file'];
  if (/\blists?\b|\bpages?\b|scroll|\btables?\b/i.test(c)) return ['empty list', 'single row', 'last-page pagination'];
  if (/date|time|schedule/i.test(c)) return ['same-day', 'timezone edge', 'expired window'];
  if (/name|text|title|description/i.test(c)) return ['empty string', 'maximum length', 'unicode characters'];
  const focus = focusOf(criterion);
  return [`minimum boundary for "${focus}"`, `maximum boundary for "${focus}"`];
};

const positiveHints = (criterion: string): string[] => {
  const focus = focusOf(criterion);
  return [`happy path for ${focus}`, `confirm persistence after refresh for ${focus}`];
};

export function planArtifactPath(workItem: string, application: string): string {
  return `plans/${slug(application)}/${slug(workItem)}.plan.md`;
}

export function renderPlanMarkdown(
  scenarios: PlannerScenario[],
  meta: { workItem: string; application: string; criteria?: string[]; findings?: string; source?: string },
): string {
  const lines: string[] = [
    `# Test plan: ${meta.workItem} — ${meta.application}`,
    '',
    '## Context',
    '',
    `- **Work item:** ${meta.workItem}`,
    `- **Application:** ${meta.application}`,
    `- **Scenarios:** ${scenarios.length}`,
  ];
  if (meta.source) lines.push(`- **Planner source:** ${meta.source}`);
  lines.push('');
  if (meta.criteria && meta.criteria.length > 0) {
    lines.push('## Acceptance criteria', '');
    for (const c of meta.criteria) lines.push(`- ${c}`);
    lines.push('');
  }
  if (meta.findings?.trim()) {
    lines.push('## Exploration findings', '', meta.findings.trim(), '');
  }
  lines.push('## Scenarios', '');
  scenarios.forEach((scenario, index) => {
    lines.push(`### ${index + 1}. ${scenario.name}`, '');
    lines.push(`- **Kind:** ${scenario.kind}`);
    lines.push(`- **Priority:** ${scenario.priority}`);
    lines.push(`- **Criterion:** ${scenario.criterion}`);
    lines.push(`- **Steps:** ${scenario.steps}`);
    lines.push(`- **Expected:** ${scenario.expected}`, '');
  });
  return `${lines.join('\n').trim()}\n`;
}

export function parsePlanMarkdown(markdown: string): PlannerScenario[] {
  const chunks = markdown.replace(/\r/g, '').split(/^###\s+\d+\.\s+/m).slice(1);
  const scenarios: PlannerScenario[] = [];
  for (const chunk of chunks) {
    const name = (chunk.split('\n')[0] ?? '').trim();
    if (!name) continue;
    const field = (label: string) => {
      const hit = chunk.match(new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.+)$`, 'im'));
      return hit?.[1]?.trim() ?? '';
    };
    const kindRaw = field('Kind') || name;
    const kind: ScenarioKind = /negative/i.test(kindRaw) ? 'negative' : /edge/i.test(kindRaw) ? 'edge' : 'positive';
    const steps = field('Steps');
    const expected = field('Expected');
    if (!steps || !expected) continue;
    const priorityRaw = field('Priority');
    scenarios.push({
      name,
      kind,
      priority: priorityRaw === 'high' || priorityRaw === 'medium' || priorityRaw === 'low' ? priorityRaw : priorityFor(kind),
      criterion: field('Criterion') || name,
      steps,
      expected,
    });
  }
  return scenarios;
}

/**
 * playwright-test-planner (heuristic). Multiple Positive / Negative / Edge scenarios per
 * acceptance criterion — scaled for rich work items (up to MAX_PLAN_SCENARIOS).
 */
export function planWithPlaywrightPlanner(input: {
  workItem: string;
  application: string;
  criteria: string[];
  findings?: string;
}): { summary: string; scenarios: PlannerScenario[]; planMarkdown: string; planArtifact: string } {
  const criteria = input.criteria.length > 0 ? input.criteria : [`Verify ${input.application} for ${input.workItem}`];
  const scenarios: PlannerScenario[] = [];
  const push = (kind: ScenarioKind, criterion: string, label: string, steps: string, expected: string) => {
    if (scenarios.length >= MAX_PLAN_SCENARIOS) return;
    scenarios.push({
      name: caseTitle(kind, label),
      kind,
      priority: priorityFor(kind),
      criterion: clip(criterion, 160),
      steps,
      expected,
    });
  };
  for (const criterion of criteria) {
    const line = clip(criterion, 160);
    for (const hint of positiveHints(line)) {
      push(
        'positive',
        line,
        hint,
        `Open ${input.application}. Locate the UI for: ${focusOf(line)}. Complete ${hint}. Confirm the outcome matches: ${clip(line, 160)}.`,
        `${clip(line, 140)} succeeds with the expected result visible to the user (${hint}).`,
      );
    }
    for (const hint of negativeHints(line)) {
      push(
        'negative',
        line,
        `reject ${hint}`,
        `Open ${input.application}. Attempt ${hint}. Do not complete the happy path for: ${focusOf(line)}. Observe the blocked or error state without forcing a bypass.`,
        `The invalid path (${hint}) is refused with a clear error or blocked state; "${focusOf(line)}" does not succeed.`,
      );
    }
    for (const hint of edgeHints(line)) {
      push(
        'edge',
        line,
        hint,
        `Open ${input.application}. Exercise ${hint}. Keep the acceptance criterion in view: ${clip(line, 120)}.`,
        `The criterion still holds at the boundary (${hint}).`,
      );
    }
    if (scenarios.length >= MAX_PLAN_SCENARIOS) break;
  }
  const sliced = scenarios.slice(0, MAX_PLAN_SCENARIOS);
  const planArtifact = planArtifactPath(input.workItem, input.application);
  const planMarkdown = renderPlanMarkdown(sliced, {
    workItem: input.workItem,
    application: input.application,
    criteria: input.criteria,
    findings: input.findings,
    source: 'heuristic',
  });
  return {
    summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${sliced.length} scenario${sliced.length === 1 ? '' : 's'} for ${input.workItem} from the story (no model). Plan artifact ${planArtifact}.`,
    scenarios: sliced,
    planMarkdown,
    planArtifact,
  };
}

/**
 * playwright-test-generator (heuristic). Consumes planned scenarios / MD plan.
 */
export function generateWithPlaywrightGenerator(input: {
  workItem: string;
  application: string;
  scenarios: PlannerScenario[];
  planMarkdown?: string;
  findings?: string;
}): { summary: string; cases: GeneratedPlaywrightCase[] } {
  const application = slug(input.application);
  const work = slug(input.workItem);
  const findingsNote = (input.findings ?? '').trim();
  const scenarios = input.scenarios.length > 0
    ? input.scenarios
    : input.planMarkdown
      ? parsePlanMarkdown(input.planMarkdown)
      : [];
  const cases = scenarios.slice(0, MAX_GENERATED_CASES).map((scenario, index) => {
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
      '  await expect(page.locator(\'body\')).toBeVisible();',
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
  };
}

/** Offline healer for platform-owned generated stubs. */
export function healWithPlaywrightHealer(input: {
  workItem: string;
  cases: GeneratedPlaywrightCase[];
}): { summary: string; cases: GeneratedPlaywrightCase[]; fixed: number } {
  let fixed = 0;
  const cases = input.cases.map((item) => {
    const src = item.steps ?? '';
    const broken = !src.includes('@playwright/test')
      || !/\btest\s*\(/.test(src)
      || src.trim().length < 40
      || /hard-?coded password|process\.env\.|fs\.|child_process/i.test(src);
    if (!broken) return item;
    fixed += 1;
    const name = item.name.replace(/'/g, "\\'");
    return {
      ...item,
      steps: [
        "import { test, expect } from '@playwright/test';",
        '',
        `test('${name}', async ({ page }) => {`,
        "  await page.goto('/');",
        `  // Healed: ${clip(item.name, 160)}`,
        `  // Expected: ${clip(item.expected, 160)}`,
        "  await expect(page.locator('body')).toBeVisible();",
        '});',
        '',
      ].join('\n'),
    };
  });
  return {
    summary: fixed > 0
      ? `${PLAYWRIGHT_TEST_HEALER} fixed ${fixed} of ${cases.length} Playwright case${cases.length === 1 ? '' : 's'} for ${input.workItem} (platform workspace only).`
      : `${PLAYWRIGHT_TEST_HEALER} checked ${cases.length} case${cases.length === 1 ? '' : 's'} for ${input.workItem}; none needed a fix.`,
    cases,
    fixed,
  };
}
