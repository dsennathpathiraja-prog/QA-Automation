import type { LlmGateway } from '@qa/llm';
import { PLAYWRIGHT_TEST_GENERATOR, generateHeuristically } from './heuristic';
import { MAX_GENERATED_CASES } from './limits';
import { parsePlanMarkdown } from './plan-markdown';
import { assessExplorationCoverage, ensureMeaningfulPlaywrightSource, isStubPlaywrightSource } from './playwright-source';
import { generateStructured } from './schemas';
import type { GenerateRequest, GenerateResult, GeneratedPlaywrightCase, PlannerScenario, TestGeneratorPort } from './types';

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'case';

const priorityOf = (kind: GeneratedPlaywrightCase['kind'], raw: unknown): GeneratedPlaywrightCase['priority'] => {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

const GEN_SYSTEM = [
  'You are playwright-test-generator for a connector-first QA platform.',
  'Consume the Markdown test plan artifact and turn EVERY planned scenario into one Playwright test (JavaScript).',
  'Do not collapse the plan into a tiny sample — emit one case per scenario in the plan (volume may be 100+).',
  'Each case needs name, kind, priority, steps (full .spec.js source using @playwright/test only), and expected.',
  'CRITICAL: Every test must include real navigation (page.goto to the explore URL when known),',
  'real interactions (getByRole / getByLabel / click / fill), and scenario-specific assertions.',
  'NEVER emit a stub whose only assertion is expect(page.locator("body")).toBeVisible().',
  'Do not leave scenario steps as comments only — implement them as Playwright calls.',
  'When exploration findings list a URL, buttons, headings, or fields AND that surface matches the scenario, use those as locators.',
  'If Explore UI only reached a shop/catalog for a notification/template WI, generate honest order-flow tests',
  '(cart / order summary) grounded in that UI — never fake Greeting/Title/email-field assertions on the catalog.',
  'If findings are near-duplicate snapshots of the same URL, do not invent distinct UI paths from them.',
  'Prefer failing/flagging weak explore coverage over body.toBeVisible() title variants.',
  'Positive / Negative / Edge cases MUST differ in actions and assertions, not only in the test title.',
  'Do not import network, filesystem, or hard-code passwords.',
  'Reply with JSON only matching the schema.',
].join(' ');

function scenariosFromInput(input: GenerateRequest): PlannerScenario[] {
  if (input.scenarios.length > 0) return input.scenarios;
  if (input.planMarkdown?.trim()) return parsePlanMarkdown(input.planMarkdown);
  return [];
}

function fallbackScenario(row: { name: string; kind: GeneratedPlaywrightCase['kind']; expected: string }, index: number): PlannerScenario {
  return {
    name: row.name,
    kind: row.kind,
    priority: priorityOf(row.kind, undefined),
    criterion: row.name,
    steps: row.expected,
    expected: row.expected,
  };
}

/** LLM-backed generator with heuristic fallback when no gateway is configured. */
export function createLlmTestGenerator(gateway: LlmGateway | undefined): TestGeneratorPort {
  if (!gateway) {
    return {
      generate: async (input) => generateHeuristically({ ...input, scenarios: scenariosFromInput(input) }),
    };
  }
  return {
    async generate(input: GenerateRequest): Promise<GenerateResult> {
      const application = slug(input.application);
      const work = slug(input.workItem);
      const scenarios = scenariosFromInput(input);
      const coverage = assessExplorationCoverage({
        findings: input.findings,
        story: scenarios.map((s) => s.criterion).join('\n'),
        criteria: scenarios.map((s) => s.criterion),
      });
      const planText = input.planMarkdown?.trim()
        || scenarios.map((s, i) => `${i + 1}. [${s.kind}/${s.priority}] ${s.name}\n   criterion: ${s.criterion}\n   steps: ${s.steps}\n   expected: ${s.expected}`).join('\n');
      const result = await gateway.generateStructured(
        { agentKey: PLAYWRIGHT_TEST_GENERATOR, executionId: input.executionId, stepId: input.stepId },
        {
          system: GEN_SYSTEM,
          instruction: [
            `Work item: ${input.workItem}`,
            `Application: ${input.application}`,
            input.planArtifact ? `Plan artifact: ${input.planArtifact}` : '',
            `Write one Playwright test per scenario in the plan. Prefer file path tests/${application}/${work}.spec.js.`,
            'Reject body-only stubs.',
            coverage.warning
              ? `Explore coverage warning: ${coverage.warning}`
              : 'Use exploration URLs and control labels as locators when the surface matches.',
            'Markdown test plan:',
            planText.slice(0, 14_000),
            input.findings ? `Exploration findings:\n${input.findings.slice(0, 4_000)}` : '',
          ].filter(Boolean).join('\n'),
          context: [
            { class: 'story', label: 'plan-markdown', text: planText.slice(0, 12_000) },
            ...(input.findings ? [{ class: 'page' as const, label: 'exploration-findings', text: input.findings.slice(0, 6_000) }] : []),
          ],
        },
        generateStructured,
        { requirements: { structuredOutput: true } },
      );
      let stubReplaced = 0;
      const cases: GeneratedPlaywrightCase[] = result.data.cases.slice(0, MAX_GENERATED_CASES).map((row, index) => {
        const scenario = scenarios[index] ?? fallbackScenario(row, index);
        const human = scenario?.steps?.trim();
        const validationSteps = row.validationSteps?.length
          ? row.validationSteps.map((s) => ({ action: s.action, expected: s.expected ?? '' }))
          : human
            ? human.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean).map((action, i, all) => ({
              action,
              expected: i === all.length - 1 ? row.expected : '',
            }))
            : undefined;
        const rawSteps = row.steps.includes('@playwright/test')
          ? row.steps
          : '';
        if (!rawSteps || isStubPlaywrightSource(rawSteps)) stubReplaced += 1;
        const steps = ensureMeaningfulPlaywrightSource({
          source: rawSteps,
          scenario: {
            ...scenario,
            name: row.name || scenario.name,
            kind: row.kind,
            expected: row.expected || scenario.expected,
          },
          application: input.application,
          findings: input.findings,
          story: scenario.criterion,
          criteria: [scenario.criterion],
          index,
        });
        return {
          name: row.name,
          kind: row.kind,
          priority: priorityOf(row.kind, row.priority),
          steps,
          expected: row.expected,
          validationSteps,
          workItem: input.workItem,
          reference: `QAP-${work}-${index + 1}`.slice(0, 50),
          file: row.file ?? `tests/${application}/${work}.spec.js`,
          testId: row.testId ?? `${work}-${row.kind}-${index + 1}`,
        };
      });
      const stubNote = stubReplaced > 0 ? ` Replaced ${stubReplaced} stub-only case${stubReplaced === 1 ? '' : 's'} with scenario-first Playwright.` : '';
      const warn = coverage.warning ? ` ${coverage.warning}` : '';
      return {
        summary: `${PLAYWRIGHT_TEST_GENERATOR} wrote ${cases.length} Playwright test${cases.length === 1 ? '' : 's'} for ${input.workItem} with a model${result.repaired ? ' (repaired once)' : ''} from the MD plan.${stubNote}${warn}`,
        cases,
        source: 'model',
      };
    },
  };
}
