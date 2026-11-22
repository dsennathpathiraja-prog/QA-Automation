import { titledCaseName } from './case-template';
import { MAX_GENERATED_CASES, MAX_PLAN_SCENARIOS } from './limits';
import { planArtifactPath, renderPlanMarkdown } from './plan-markdown';
import { isCodeExploreNoise } from './code-explorer';
import {
  assessExplorationCoverage,
  buildMeaningfulPlaywrightSource,
  exploreSupportsDistinctUiScenarios,
  isTemplateSurfaceScenario,
  type ExploreCoverage,
} from './playwright-source';
import { notificationTemplateScenarioSeeds } from './story-scenarios';
import { bindStorySurface, NEEDS_SURFACE_MARKER, NEEDS_SURFACE_TAG } from './surface-binding';
import type { GeneratedPlaywrightCase, GenerateRequest, GenerateResult, PlanRequest, PlanResult, PlannerScenario, ScenarioKind, ScenarioPriority } from './types';

/** Drop noisy Source: code-explore dumps so they do not drive scenarios. */
function findingsForPlanning(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  const parts = raw.split(/\n(?=UI:|Source:)/);
  const kept: string[] = [];
  for (const part of parts) {
    const t = part.trim();
    if (!t) continue;
    if (/^Source:/i.test(t) && isCodeExploreNoise(t.replace(/^Source:\s*/i, ''))) continue;
    if (isCodeExploreNoise(t) && /Code explore not relevant|path-only/i.test(t)) continue;
    kept.push(t);
  }
  return kept.join('\n').trim() || undefined;
}

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

/** Title line after the work-item id (or `id — title` on the first line). */
export function workItemTitleFromStory(raw: string): string {
  const lines = raw.replace(/\r/g, '').split('\n');
  const firstIdx = lines.findIndex((line) => line.trim());
  if (firstIdx < 0) return '';
  const first = (lines[firstIdx] ?? '').trim();
  const inline = first.match(/^(?:\d{1,10}|[A-Z][A-Z0-9]+-\d+)\s*[—–:\-]\s+(.+)$/i);
  if (inline?.[1]) {
    const titled = inline[1].replace(/^[\s>*\-•\d.)]+/, '').trim();
    if (titled && !/^(#{1,6}\s|acceptance criteria\b)/i.test(titled)) return titled.slice(0, 200);
  }
  for (let i = firstIdx + 1; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    if (!rawLine.trim()) return '';
    const line = rawLine.replace(/^[\s>*\-•\d.)]+/, '').trim();
    if (!line || /^(#{1,6}\s|acceptance criteria\b|repro(duction)? steps\b|description\b|notes?\b|business rules?\b)/i.test(line)) return '';
    if (/^(given|when|then|and)\b/i.test(line)) return '';
    return line.slice(0, 200);
  }
  return '';
}

const caseTitle = (kind: ScenarioKind, label: string, workItemTitle: string): string => (
  titledCaseName({ kind, title: workItemTitle, goal: clip(label, 90) }).slice(0, 120)
);

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
  if (/escrow|notification.?template|template.?field/i.test(c)) {
    return ['missing order amount in template', 'template render without paid amount', 'notification blocked when amount blank'];
  }
  if (/pay|card|checkout|payment|amount|escrow/i.test(c)) {
    return ['declined card', 'missing CVV', 'unsupported currency', 'network timeout at authorize'];
  }
  if (/upload|file|attach/i.test(c)) {
    return ['unsupported file type', 'oversize payload', 'empty file', 'malware-flagged file'];
  }
  if (/search|filter|list/i.test(c)) {
    return ['empty query', 'unknown filter', 'no matching rows', 'SQL-like injection string'];
  }
  if (/email|notif|message|template/i.test(c)) {
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
  if (/escrow|notification.?template|paid.?amount|order.?amount/i.test(c)) {
    return ['zero amount in escrow notification', 'maximum amount in template', 'amount placement before currency symbol', 'partial paid amount token'];
  }
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
  if (/name|text|title|description|template/i.test(c)) {
    return ['empty string', 'maximum length', 'unicode characters', 'leading/trailing whitespace'];
  }
  const focus = focusOf(criterion);
  return [
    `minimum boundary for "${focus}"`,
    `maximum boundary for "${focus}"`,
    `alternate path around "${focus}"`,
  ];
}

/** Distinct positive goals — never title-only variants of one stub. */
function positiveHints(criterion: string): string[] {
  const c = criterion.toLowerCase();
  const focus = focusOf(criterion);
  if (/escrow|notification.?template|paid.?amount|order.?amount|greeting|main message/i.test(c)) {
    return [
      `show paid amount in escrow notification template`,
      `place order amount in the correct template field`,
      `confirm notification preview after amount placement`,
    ];
  }
  if (/pay|card|checkout|payment/i.test(c)) {
    return [
      `complete checkout with valid payment for ${focus}`,
      `verify receipt shows ${focus}`,
      `confirm payment state after refresh for ${focus}`,
    ];
  }
  if (/search|filter|list/i.test(c)) {
    return [
      `search and open a matching row for ${focus}`,
      `filter the list to isolate ${focus}`,
      `confirm list persists ${focus} after refresh`,
    ];
  }
  return [
    `complete primary flow for ${focus}`,
    `verify visible outcome for ${focus}`,
    `confirm persistence after refresh for ${focus}`,
  ];
}

/**
 * Distinct UI-path seeds from explore — only when coverage is strong and surfaces differ.
 * Near-duplicate shop snapshots must NOT invent per-AC Greeting/Title UI scenarios.
 */
function explorationScenarioSeeds(
  coverage: ExploreCoverage,
  criterion: string,
): { kind: ScenarioKind; label: string; steps: string; expected: string }[] {
  if (!exploreSupportsDistinctUiScenarios(coverage)) return [];
  const cues = coverage.cues;
  if (!cues.url && cues.buttons.length === 0 && cues.fields.length === 0 && cues.headings.length === 0) return [];
  const focus = focusOf(criterion);
  const url = cues.url || '/';
  const seeds: { kind: ScenarioKind; label: string; steps: string; expected: string }[] = [];
  if (cues.buttons[0]) {
    seeds.push({
      kind: 'positive',
      label: `use ${cues.buttons[0]} control for ${focus}`,
      steps: `Open ${url}. Click "${cues.buttons[0]}". Complete the path for: ${focus}. Confirm the outcome is visible.`,
      expected: `"${cues.buttons[0]}" leads to a successful outcome for ${focus}.`,
    });
  }
  if (cues.fields[0]) {
    seeds.push({
      kind: 'negative',
      label: `reject blank ${cues.fields[0]} for ${focus}`,
      steps: `Open ${url}. Leave "${cues.fields[0]}" blank. Attempt to continue. Observe validation or blocked state for: ${focus}.`,
      expected: `Blank "${cues.fields[0]}" is refused; ${focus} does not succeed.`,
    });
  }
  if (cues.headings[0] || cues.title) {
    const surface = cues.headings[0] || cues.title;
    seeds.push({
      kind: 'edge',
      label: `reach ${surface} then exercise ${focus}`,
      steps: `Open ${url}. Confirm heading "${surface}". Exercise a boundary for: ${focus}.`,
      expected: `Surface "${surface}" remains reachable while ${focus} holds at the boundary.`,
    });
  }
  return seeds;
}

/** Extra path seeds from Description body (beyond AC bullets). */
export function descriptionPathSeeds(story: string, criteria: string[]): string[] {
  const criteriaSet = new Set(criteria.map((c) => c.toLowerCase()));
  const title = workItemTitleFromStory(story).toLowerCase();
  const lines = story.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const seeds: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/^[\s>*\-•\d.)]+/, '').trim();
    if (!line || line.length < 12) continue;
    if (/^(#{1,6}\s|acceptance criteria\b|repro(duction)? steps\b|description\b|notes?\b)/i.test(line)) continue;
    if (/^\d{1,10}$/.test(line) || /^[A-Z][A-Z0-9]+-\d+$/i.test(line)) continue;
    if (/^(?:\d{1,10}|[A-Z][A-Z0-9]+-\d+)\s*[—–:\-]\s+/i.test(line)) continue;
    if (title && line.toLowerCase() === title) continue;
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
  workItemTitle: string,
): void {
  if (scenarios.length >= MAX_PLAN_SCENARIOS) return;
  scenarios.push({
    name: caseTitle(kind, label, workItemTitle),
    kind,
    priority: priorityFor(kind),
    criterion: clip(criterion, 160),
    steps,
    expected,
  });
}

/**
 * Description-aware heuristic planner (in-repo stand-in for playwright-test-planner).
 * Scenario identity comes from WI description/AC first (story analysis). Explore supplies
 * selectors only when the surface matches. Duplicate shop snapshots and noisy code explore
 * do not invent catalog/email-field scenarios.
 */
export function planHeuristically(input: PlanRequest): PlanResult {
  const workItemTitle = workItemTitleFromStory(input.story);
  const criteria = input.criteria.length > 0
    ? input.criteria
    : [workItemTitle
      ? `${workItemTitle} on ${input.application}`
      : `Verify ${input.application} for ${input.workItem}`];
  const planningFindings = findingsForPlanning(input.findings);
  const scenarios: PlannerScenario[] = [];
  const coverage = assessExplorationCoverage({
    findings: planningFindings,
    story: input.story,
    criteria,
  });
  const cues = coverage.cues;
  const weakExplore = coverage.kind === 'secondary' || coverage.kind === 'weak'
    || (coverage.shopSurface && coverage.templateWorkItem);

  // 1) Story-authoritative notification/escrow template themes (WI 2357-style).
  const storySeeds = notificationTemplateScenarioSeeds({
    story: input.story,
    criteria,
    workItemTitle,
  });
  for (const seed of storySeeds) {
    pushScenario(scenarios, seed.kind, seed.criterion, seed.label, seed.steps, seed.expected, workItemTitle);
  }

  // 2) Generic AC/description expansion only when story themes did not already cover the WI.
  if (storySeeds.length === 0) {
    const pathSeeds = descriptionPathSeeds(input.story, criteria);
    const seeds = [...criteria, ...pathSeeds.filter((s) => !criteria.includes(s))];
    const openTarget = cues.url && !weakExplore
      ? `Open ${cues.url}${cues.title ? ` (${cues.title})` : ''}.`
      : `Open ${input.application}.`;

    for (const criterion of seeds) {
      const line = clip(criterion, 160);
      for (const hint of positiveHints(line)) {
        pushScenario(
          scenarios,
          'positive',
          line,
          hint,
          [
            openTarget,
            exploreSupportsDistinctUiScenarios(coverage) && cues.buttons[0]
              ? `Use control "${cues.buttons[0]}".`
              : `Locate the UI for: ${focusOf(line)}.`,
            `Complete: ${hint}.`,
            `Assert the visible outcome for: ${clip(line, 160)}.`,
          ].join(' '),
          `${clip(line, 140)} succeeds with a visible outcome (${hint}).`,
          workItemTitle,
        );
      }
      for (const hint of negativeHints(line)) {
        pushScenario(
          scenarios,
          'negative',
          line,
          `reject ${hint}`,
          [
            openTarget,
            `Attempt ${hint}.`,
            `Do not complete the happy path for: ${focusOf(line)}.`,
            'Observe the blocked or error state without forcing a bypass.',
          ].join(' '),
          `The invalid path (${hint}) is refused with a clear error or blocked state; "${focusOf(line)}" does not succeed.`,
          workItemTitle,
        );
      }
      for (const hint of edgeHints(line)) {
        pushScenario(
          scenarios,
          'edge',
          line,
          hint,
          [
            openTarget,
            `Exercise ${hint}.`,
            `Keep the acceptance criterion in view: ${clip(line, 120)}.`,
          ].join(' '),
          `The criterion still holds at the boundary (${hint}).`,
          workItemTitle,
        );
      }
      for (const seed of explorationScenarioSeeds(coverage, line)) {
        pushScenario(scenarios, seed.kind, line, seed.label, seed.steps, seed.expected, workItemTitle);
      }
      if (scenarios.length >= MAX_PLAN_SCENARIOS) break;
    }
  }

  const sliced = scenarios.slice(0, MAX_PLAN_SCENARIOS);
  const binding = bindStorySurface({
    story: input.story,
    criteria,
    workItemTitle,
    application: input.application,
    environmentUrl: input.environmentUrl,
  });
  const blockingGap = coverage.blockingGap
    || (coverage.templateWorkItem && coverage.shopSurface);
  const exploreWarning = [
    coverage.warning,
    blockingGap
      ? 'Template/email scenarios will be Blocked (needs-surface) until a matching preview/template URL is reachable — shop catalog is not successful coverage.'
      : weakExplore && storySeeds.length > 0
        ? 'Scenarios grounded in work item story/AC; weak shop explore was not used to invent catalog cases.'
        : '',
  ].filter(Boolean).join(' ');
  const planMarkdown = renderPlanMarkdown(sliced, {
    workItem: input.workItem,
    application: input.application,
    criteria: input.criteria,
    findings: planningFindings,
    source: 'heuristic',
    exploreWarning: exploreWarning || undefined,
    blockingGap,
    surfaceKind: binding.surfaceKind,
    primarySurfaceUrl: binding.primarySurfaceUrl || coverage.primarySurfaceUrl,
    candidateRoutes: binding.candidateRoutes,
  });
  const planArtifact = planArtifactPath(input.workItem, input.application);
  const warn = exploreWarning ? ` ${exploreWarning}` : '';
  return {
    summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${sliced.length} scenario${sliced.length === 1 ? '' : 's'} for ${input.workItem} from the story (no model). Plan artifact ${planArtifact}.${warn}`,
    scenarios: sliced,
    planMarkdown,
    planArtifact,
    source: 'heuristic',
    exploreWarning: exploreWarning || undefined,
    blockingGap,
    surfaceKind: binding.surfaceKind,
    primarySurfaceUrl: binding.primarySurfaceUrl || coverage.primarySurfaceUrl,
  };
}

/**
 * Heuristic generator (in-repo stand-in for playwright-test-generator).
 * Consumes planned scenarios and emits real navigation / interactions / assertions
 * from exploration cues — never body-visibility-only stubs.
 */
export function generateHeuristically(input: GenerateRequest): GenerateResult {
  const application = slug(input.application);
  const work = slug(input.workItem);
  const storyBlob = input.story
    || input.planMarkdown
    || input.scenarios.map((s) => `${s.criterion}\n${s.name}\n${s.steps}`).join('\n');
  const coverage = assessExplorationCoverage({
    findings: input.findings,
    story: storyBlob,
    criteria: input.scenarios.map((s) => s.criterion),
  });
  const binding = bindStorySurface({
    story: storyBlob,
    criteria: input.scenarios.map((s) => s.criterion),
    application: input.application,
    environmentUrl: input.environmentUrl,
  });
  const blockingGap = coverage.blockingGap
    || (coverage.templateWorkItem && coverage.shopSurface);
  const cases: GeneratedPlaywrightCase[] = input.scenarios.slice(0, MAX_GENERATED_CASES).map((scenario, index) => {
    const testId = `${work}-${scenario.kind}-${index + 1}`;
    const file = `tests/${application}/${work}.spec.js`;
    const needsSurface = blockingGap && isTemplateSurfaceScenario(scenario);
    const source = buildMeaningfulPlaywrightSource({
      scenario,
      application: input.application,
      findings: input.findings,
      story: storyBlob,
      criteria: [scenario.criterion],
      index,
    });
    const gapExpected = needsSurface
      ? `Blocked (${NEEDS_SURFACE_TAG}): ${coverage.warning || 'Required notification/template surface was not explored.'}`
      : scenario.expected;
    const humanParts = needsSurface
      ? [
        'Do not execute email/template assertions against the shop/catalog host.',
        gapExpected,
      ]
      : scenario.steps
        .split(/(?<=[.!?])\s+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 40);
    const validationSteps = (humanParts.length > 0 ? humanParts : [scenario.steps.trim()]).map((action, i, all) => ({
      action,
      expected: i === all.length - 1 ? gapExpected : '',
    }));
    return {
      name: scenario.name,
      kind: scenario.kind,
      priority: scenario.priority,
      steps: source,
      expected: gapExpected,
      validationSteps,
      workItem: input.workItem,
      reference: `QAP-${work}-${index + 1}`.slice(0, 50),
      file,
      testId,
      ...(needsSurface
        ? {
          runStatus: 'Blocked' as const,
          tags: [NEEDS_SURFACE_TAG],
          primarySurfaceUrl: binding.primarySurfaceUrl || coverage.primarySurfaceUrl,
          surfaceKind: binding.surfaceKind,
        }
        : {
          primarySurfaceUrl: binding.primarySurfaceUrl || coverage.primarySurfaceUrl,
          surfaceKind: binding.surfaceKind,
        }),
    };
  });
  const blocked = cases.filter((c) => c.runStatus === 'Blocked').length;
  const warn = coverage.warning ? ` ${coverage.warning}` : '';
  const gapNote = blocked > 0
    ? ` ${blocked} case${blocked === 1 ? '' : 's'} marked Blocked (${NEEDS_SURFACE_MARKER}) due to explore surface gap.`
    : '';
  return {
    summary: `${PLAYWRIGHT_TEST_GENERATOR} wrote ${cases.length} Playwright test${cases.length === 1 ? '' : 's'} for ${input.workItem} from the plan (no model).${gapNote}${warn}`,
    cases,
    source: 'heuristic',
  };
}
