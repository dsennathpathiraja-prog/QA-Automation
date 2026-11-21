import type { LlmGateway } from '@qa/llm';
import { PLAYWRIGHT_TEST_PLANNER, planHeuristically } from './heuristic';
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
  'Read the work item story and acceptance criteria. Produce meaningful Positive, Negative, and Edge scenarios.',
  'Every acceptance criterion must yield exactly three scenarios (positive, negative, edge) unless the list would exceed 40 total.',
  'Names must start with "Positive:", "Negative:", or "Edge:".',
  'Steps and expected results must reference the criterion text — never generic placeholders alone.',
  'Reply with JSON only matching the schema.',
].join(' ');

/**
 * LLM-backed planner. Falls back to the description-aware heuristic when no gateway is wired.
 * When a gateway is present, a bad model answer fails the stage after one repair (gateway-owned).
 */
export function createLlmTestPlanner(gateway: LlmGateway | undefined): TestPlannerPort {
  if (!gateway) {
    return { plan: async (input) => planHeuristically(input) };
  }
  return {
    async plan(input: PlanRequest): Promise<PlanResult> {
      const criteriaBlock = input.criteria.length > 0
        ? input.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : '(no separate acceptance criteria — derive scenarios from the story)';
      const result = await gateway.generateStructured(
        { agentKey: PLAYWRIGHT_TEST_PLANNER, executionId: input.executionId, stepId: input.stepId },
        {
          system: PLAN_SYSTEM,
          instruction: [
            `Work item: ${input.workItem}`,
            `Application: ${input.application}`,
            'Write Positive / Negative / Edge scenarios for each acceptance criterion.',
            'Acceptance criteria:',
            criteriaBlock,
          ].join('\n'),
          context: [
            { class: 'story', label: 'work-item-story', text: input.story.slice(0, 12_000) },
          ],
        },
        planStructured,
        { requirements: { structuredOutput: true } },
      );
      const scenarios: PlannerScenario[] = result.data.scenarios.slice(0, 40).map((row) => ({
        name: row.name,
        kind: row.kind,
        priority: priorityOf(row.kind, row.priority),
        criterion: row.criterion,
        steps: row.steps,
        expected: row.expected,
      }));
      return {
        summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} for ${input.workItem} with a model${result.repaired ? ' (repaired once)' : ''}.`,
        scenarios,
        source: 'model',
      };
    },
  };
}
