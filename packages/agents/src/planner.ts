import type { LlmGateway } from '@qa/llm';
import { PLAYWRIGHT_TEST_PLANNER, planHeuristically } from './heuristic';
import { MAX_PLAN_SCENARIOS } from './limits';
import { planArtifactPath, renderPlanMarkdown } from './plan-markdown';
import { planStructured } from './schemas';
import type { PlanRequest, PlanResult, PlannerScenario, TestPlannerPort } from './types';

const priorityOf = (kind: PlannerScenario['kind'], raw: unknown): PlannerScenario['priority'] => {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

const PLAN_SYSTEM = [
  'You are playwright-test-planner for a connector-first QA platform used by non-technical users.',
  'Read the work item story, Description paths, acceptance criteria, and exploration findings.',
  'Produce a solid, high-volume set of Positive, Negative, and Edge scenarios.',
  'Do NOT stop at one positive + one negative + one edge per criterion.',
  'Each acceptance criterion and each distinct Description path should yield multiple scenarios',
  '(several happy paths, several invalid paths, several boundaries) when the text supports them.',
  'A single rich work item may need 100+ scenarios; stay under the schema max.',
  'Names must start with "Positive:", "Negative:", or "Edge:".',
  'Steps and expected results must reference the criterion or path text — never generic placeholders alone.',
  'Use exploration findings to name real pages and controls when present.',
  'Reply with JSON only matching the schema.',
].join(' ');

/**
 * LLM-backed planner. Falls back to the description-aware heuristic when no gateway is wired.
 * When a gateway is present, a bad model answer fails the stage after one repair (gateway-owned).
 * Always persists a Markdown plan artifact for the generator.
 */
export function createLlmTestPlanner(gateway: LlmGateway | undefined): TestPlannerPort {
  if (!gateway) {
    return { plan: async (input) => planHeuristically(input) };
  }
  return {
    async plan(input: PlanRequest): Promise<PlanResult> {
      const criteriaBlock = input.criteria.length > 0
        ? input.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : '(no separate acceptance criteria — derive scenarios from the story Description)';
      const result = await gateway.generateStructured(
        { agentKey: PLAYWRIGHT_TEST_PLANNER, executionId: input.executionId, stepId: input.stepId },
        {
          system: PLAN_SYSTEM,
          instruction: [
            `Work item: ${input.workItem}`,
            `Application: ${input.application}`,
            'Write many Positive / Negative / Edge scenarios covering each acceptance criterion and Description path.',
            'Acceptance criteria:',
            criteriaBlock,
            input.findings ? `Exploration findings:\n${input.findings}` : 'Exploration findings: (none yet)',
          ].join('\n'),
          context: [
            { class: 'story', label: 'work-item-story', text: input.story.slice(0, 12_000) },
            ...(input.findings ? [{ class: 'page' as const, label: 'exploration-findings', text: input.findings.slice(0, 6_000) }] : []),
          ],
        },
        planStructured,
        { requirements: { structuredOutput: true } },
      );
      const scenarios: PlannerScenario[] = result.data.scenarios.slice(0, MAX_PLAN_SCENARIOS).map((row) => ({
        name: row.name,
        kind: row.kind,
        priority: priorityOf(row.kind, row.priority),
        criterion: row.criterion,
        steps: row.steps,
        expected: row.expected,
      }));
      const planMarkdown = renderPlanMarkdown(scenarios, {
        workItem: input.workItem,
        application: input.application,
        criteria: input.criteria,
        findings: input.findings,
        source: 'model',
      });
      const planArtifact = planArtifactPath(input.workItem, input.application);
      return {
        summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} for ${input.workItem} with a model${result.repaired ? ' (repaired once)' : ''}. Plan artifact ${planArtifact}.`,
        scenarios,
        planMarkdown,
        planArtifact,
        source: 'model',
      };
    },
  };
}
