import type {
  BrowserExplorerPort,
  ExploreResult,
  GenerateResult,
  PlanResult,
  PlannerScenario,
  TestGeneratorPort,
  TestPlannerPort,
} from '@qa/agents';
import { runFlowStep, type FlowResult } from '@qa/workflow-engine';

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []);

const scenariosOf = (value: unknown): PlannerScenario[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Partial<PlannerScenario>;
    const name = text(row.name);
    const kind = row.kind === 'negative' || row.kind === 'edge' ? row.kind : 'positive';
    const criterion = text(row.criterion) || name;
    const steps = text(row.steps);
    const expected = text(row.expected);
    if (!name || !steps || !expected) return [];
    const priority = row.priority === 'high' || row.priority === 'medium' || row.priority === 'low'
      ? row.priority
      : kind === 'negative' ? 'high' : kind === 'edge' ? 'low' : 'medium';
    return [{ name, kind, priority, criterion, steps, expected }];
  });
};

export interface RequirementAgentPorts {
  planner?: TestPlannerPort;
  generator?: TestGeneratorPort;
  explorer?: BrowserExplorerPort;
  /** Resolve an environment id (or name) to an application URL for UI exploration. */
  resolveEnvironmentUrl?: (environment: string) => Promise<string | undefined>;
}

/**
 * Runs one requirement-validation stage through planner / generator / browser agents when
 * wired, otherwise falls back to the sync heuristic flow in workflow-engine.
 */
export async function performRequirementStep(
  step: { id: string; type: string; runId: string; params: Record<string, unknown>; prior: Record<string, Record<string, unknown>> },
  ports: RequirementAgentPorts,
): Promise<FlowResult> {
  const story = text(step.params.story);
  const application = text(step.params.applicationName) || 'the application';
  const environment = text(step.params.environment);
  const storyOut = step.prior.read_story ?? {};
  const criteria = list(storyOut.acceptanceCriteria);
  const workItem = text(storyOut.workItem) || 'work-item';
  const fullStory = text(storyOut.story) || story;
  const scenarios = scenariosOf(step.prior.plan?.scenarios);

  if (step.type === 'rv.generate-test-plan' && ports.planner) {
    const planned: PlanResult = await ports.planner.plan({
      workItem,
      application,
      story: fullStory,
      criteria,
      executionId: step.runId,
      stepId: step.id,
    });
    return {
      summary: planned.summary,
      outputs: {
        scenarios: planned.scenarios,
        workItem,
        applicationName: application,
        environment,
        agent: 'playwright-test-planner',
        source: planned.source,
      },
    };
  }

  if (step.type === 'rv.explore-ui' && ports.explorer) {
    const url = ports.resolveEnvironmentUrl && environment
      ? await ports.resolveEnvironmentUrl(environment)
      : undefined;
    const explored: ExploreResult = await ports.explorer.explore({
      application,
      environment: environment || undefined,
      url,
      scenarios,
      maxPages: 5,
      executionId: step.runId,
      stepId: step.id,
    });
    return {
      summary: explored.summary,
      outputs: {
        findings: explored.findings,
        details: explored.details.map(({ scenarioName, url: pageUrl, snapshotExcerpt }) => ({
          scenarioName,
          url: pageUrl,
          snapshotExcerpt,
          // Keep screenshots out of step outputs (large); execution path stores them later.
        })),
        source: explored.source,
      },
    };
  }

  if (step.type === 'rv.generate-tests' && ports.generator) {
    const source = scenarios.length > 0
      ? scenarios
      : (await (ports.planner?.plan({
        workItem,
        application,
        story: fullStory,
        criteria,
        executionId: step.runId,
        stepId: step.id,
      }) ?? { scenarios: [] })).scenarios;
    const findings = text(step.prior.consolidate?.findings)
      || text(step.prior.consolidate?.combined)
      || text(step.prior.explore_ui?.findings);
    const generated: GenerateResult = await ports.generator.generate({
      workItem,
      application,
      scenarios: source,
      findings: findings || undefined,
      executionId: step.runId,
      stepId: step.id,
    });
    return {
      summary: generated.summary,
      outputs: {
        cases: generated.cases,
        workItem,
        agent: 'playwright-test-generator',
        source: generated.source,
      },
    };
  }

  return runFlowStep(step);
}
