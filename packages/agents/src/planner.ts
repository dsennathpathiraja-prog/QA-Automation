import type { LlmGateway } from '@qa/llm';
import { titledCaseName } from './case-template';
import { PLAYWRIGHT_TEST_PLANNER, planHeuristically, workItemTitleFromStory } from './heuristic';
import { MAX_PLAN_SCENARIOS } from './limits';
import { planArtifactPath, renderPlanMarkdown } from './plan-markdown';
import { assessExplorationCoverage } from './playwright-source';
import { bindStorySurface } from './surface-binding';
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
  'STEP 1 — Identify scenarios FIRST from the work item title, description, and acceptance criteria.',
  'UI/code exploration only supplies selectors or secondary paths when the explored surface matches the scenario.',
  'Each scenario must be a concrete, distinct user goal or data path',
  '(happy path, validation/negative, edge amounts, template fields, notification content, etc.).',
  'Do NOT invent title-only variants of one scenario (e.g. "happy path for Title" vs "repeat path for Title").',
  'If Explore UI returns near-duplicate snapshots of the same URL for different AC labels',
  '(e.g. every AC lands on /shop with the same catalog), do NOT invent distinct UI scenarios from those findings.',
  'Prefer flagging weak explore coverage over fabricating Greeting/Title/template tests on a catalog page.',
  'If only a shop/catalog host is reachable for a notification/email-template work item (blocking explore gap),',
  'keep scenario identity from the WI but flag those email-field scenarios as needs-surface / Blocked —',
  'not fake Passed assertions of email template fields that were never explored.',
  'Order-placement → notification-trigger scenarios may still use shop UI when the WI requires that path.',
  'STEP 2 — Plan test cases mapped 1:1 to those scenarios.',
  'Produce a solid, high-volume set of Positive, Negative, and Edge scenarios.',
  'Do NOT stop at one positive + one negative + one edge per criterion.',
  'Each acceptance criterion and each distinct Description path should yield multiple scenarios',
  '(several happy paths, several invalid paths, several boundaries) when the text supports them.',
  'A single rich work item may need 100+ scenarios; stay under the schema max.',
  'Names must start with "Positive:", "Negative:", or "Edge:" and include the work item TITLE after the kind',
  '(e.g. "Positive: PayNSure checkout — saved card is listed"), not only the work item id.',
  'Steps and expected results must reference the criterion or path text — never generic placeholders alone.',
  'Use exploration findings to name real pages, URLs, and controls only when the surface matches.',
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
      const workItemTitle = workItemTitleFromStory(input.story);
      const coverage = assessExplorationCoverage({
        findings: input.findings,
        story: input.story,
        criteria: input.criteria,
      });
      const binding = bindStorySurface({
        story: input.story,
        criteria: input.criteria,
        workItemTitle,
        application: input.application,
        environmentUrl: input.environmentUrl,
      });
      const blockingGap = coverage.blockingGap
        || (coverage.templateWorkItem && coverage.shopSurface);
      const criteriaBlock = input.criteria.length > 0
        ? input.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : '(no separate acceptance criteria — derive scenarios from the story Description)';
      const result = await gateway.generateStructured(
        { agentKey: PLAYWRIGHT_TEST_PLANNER, executionId: input.executionId, stepId: input.stepId },
        {
          system: PLAN_SYSTEM,
          instruction: [
            `Work item: ${input.workItem}`,
            workItemTitle ? `Work item title: ${workItemTitle}` : 'Work item title: (not provided — use the story headline)',
            `Application: ${input.application}`,
            `Expected surface kind: ${binding.surfaceKind}`,
            binding.primarySurfaceUrl
              ? `Primary validation URL: ${binding.primarySurfaceUrl}`
              : 'Primary validation URL: (not bound from WI)',
            'Identify distinct scenarios first from WI description/AC, then map one plan entry per scenario.',
            'Write many Positive / Negative / Edge scenarios covering each acceptance criterion and Description path.',
            'Put the work item title in every scenario name after the kind prefix.',
            coverage.warning
              ? `Explore coverage warning: ${coverage.warning}`
              : 'When findings include a matching URL or controls, put them in Steps.',
            blockingGap
              ? 'Blocking explore gap is set — email/template scenarios must not be treated as covered by shop catalog.'
              : '',
            'Acceptance criteria:',
            criteriaBlock,
            input.findings ? `Exploration findings:\n${input.findings}` : 'Exploration findings: (none yet)',
          ].filter(Boolean).join('\n'),
          context: [
            { class: 'story', label: 'work-item-story', text: input.story.slice(0, 12_000) },
            ...(input.findings ? [{ class: 'page' as const, label: 'exploration-findings', text: input.findings.slice(0, 6_000) }] : []),
          ],
        },
        planStructured,
        { requirements: { structuredOutput: true } },
      );
      const scenarios: PlannerScenario[] = result.data.scenarios.slice(0, MAX_PLAN_SCENARIOS).map((row) => ({
        name: titledCaseName({
          kind: row.kind === 'negative' || row.kind === 'edge' ? row.kind : 'positive',
          title: workItemTitle,
          goal: row.name.replace(/^(positive|negative|edge)\s*:\s*/i, '').trim() || row.criterion,
        }),
        kind: row.kind,
        priority: priorityOf(row.kind, row.priority),
        criterion: row.criterion,
        steps: row.steps,
        expected: row.expected,
      }));
      const exploreWarning = [
        coverage.warning,
        blockingGap
          ? 'Template/email scenarios will be Blocked (needs-surface) until a matching preview/template URL is reachable.'
          : '',
      ].filter(Boolean).join(' ');
      const planMarkdown = renderPlanMarkdown(scenarios, {
        workItem: input.workItem,
        application: input.application,
        criteria: input.criteria,
        findings: input.findings,
        source: 'model',
        exploreWarning: exploreWarning || undefined,
        blockingGap,
        surfaceKind: binding.surfaceKind,
        primarySurfaceUrl: binding.primarySurfaceUrl || coverage.primarySurfaceUrl,
        candidateRoutes: binding.candidateRoutes,
      });
      const planArtifact = planArtifactPath(input.workItem, input.application);
      const warn = exploreWarning ? ` ${exploreWarning}` : '';
      return {
        summary: `${PLAYWRIGHT_TEST_PLANNER} wrote ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} for ${input.workItem} with a model${result.repaired ? ' (repaired once)' : ''}. Plan artifact ${planArtifact}.${warn}`,
        scenarios,
        planMarkdown,
        planArtifact,
        source: 'model',
        exploreWarning: exploreWarning || undefined,
        blockingGap,
        surfaceKind: binding.surfaceKind,
        primarySurfaceUrl: binding.primarySurfaceUrl || coverage.primarySurfaceUrl,
      };
    },
  };
}
