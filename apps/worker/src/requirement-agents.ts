import {
  exploreCodeArtifactPath,
  exploreUiArtifactPath,
  parsePlanMarkdown,
  renderExploreCodeMarkdown,
  renderExploreUiMarkdown,
  type BrowserExplorerPort,
  type CodeExploreResult,
  type CodeExplorerPort,
  type ExploreResult,
  type GenerateResult,
  type HealResult,
  type PlanResult,
  type PlannerScenario,
  type TestGeneratorPort,
  type TestHealerPort,
  type TestPlannerPort,
} from '@qa/agents';
import { PlatformError } from '@qa/domain';
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

const casesOf = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Record<string, unknown>;
    const name = text(row.name);
    const steps = text(row.steps);
    const expected = text(row.expected);
    if (!name || !steps || !expected) return [];
    const kind = row.kind === 'negative' || row.kind === 'edge' ? row.kind : 'positive';
    const priority = row.priority === 'high' || row.priority === 'medium' || row.priority === 'low'
      ? row.priority
      : kind === 'negative' ? 'high' : kind === 'edge' ? 'low' : 'medium';
    const validationSteps = Array.isArray(row.validationSteps)
      ? (row.validationSteps as { action?: unknown; expected?: unknown }[]).flatMap((s) => {
        const action = text(s?.action);
        if (!action) return [];
        return [{ action, expected: text(s?.expected) }];
      })
      : undefined;
    return [{
      name,
      kind: kind as 'positive' | 'negative' | 'edge',
      priority: priority as 'high' | 'medium' | 'low',
      steps,
      expected,
      validationSteps: validationSteps && validationSteps.length > 0 ? validationSteps : undefined,
      workItem: text(row.workItem),
      reference: text(row.reference),
      file: text(row.file),
      testId: text(row.testId),
    }];
  });
};

export interface RequirementAgentPorts {
  planner?: TestPlannerPort;
  generator?: TestGeneratorPort;
  healer?: TestHealerPort;
  explorer?: BrowserExplorerPort;
  codeExplorer?: CodeExplorerPort;
  /** Resolve an environment id (or name) to an application URL for UI exploration. */
  resolveEnvironmentUrl?: (environment: string) => Promise<string | undefined>;
}

/**
 * Runs one requirement-validation stage through planner / generator / healer / browser
 * / source-repo agents when wired, otherwise falls back to the sync heuristic flow in workflow-engine.
 *
 * Order: explore → consolidate → plan (MD) → generate (from MD) → heal → publish.
 * Explore UI / Explore code must succeed (real connector calls) before plan runs.
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
  const findings = text(step.prior.consolidate?.findings)
    || text(step.prior.consolidate?.combined)
    || text(step.prior.explore_ui?.findings);
  const scenarios = scenariosOf(step.prior.plan?.scenarios);
  const planMarkdown = text(step.prior.plan?.planMarkdown);
  const planArtifact = text(step.prior.plan?.planArtifact);

  if (step.type === 'rv.explore-ui') {
    if (!ports.explorer) {
      throw new PlatformError('denied', 'Explore UI requires a Playwright browser explorer on the worker before planning.');
    }
    const url = ports.resolveEnvironmentUrl && environment
      ? await ports.resolveEnvironmentUrl(environment)
      : undefined;
    const explored: ExploreResult = await ports.explorer.explore({
      application,
      environment: environment || undefined,
      url,
      criteria,
      scenarios: [],
      maxPages: 5,
      executionId: step.runId,
      stepId: step.id,
    });
    if (explored.source === 'skipped') {
      throw new PlatformError('validation', explored.summary || 'Explore UI did not open the application.');
    }
    const details = explored.details.map(({ scenarioName, url: pageUrl, snapshotExcerpt }) => ({
      scenarioName,
      url: pageUrl,
      snapshotExcerpt,
    }));
    const artifactMarkdown = renderExploreUiMarkdown({
      workItem,
      application,
      findings: explored.findings,
      details: explored.details,
    });
    return {
      summary: explored.summary,
      outputs: {
        findings: explored.findings,
        details,
        source: explored.source,
        artifactMarkdown,
        artifactPath: exploreUiArtifactPath(workItem, application),
      },
    };
  }

  if (step.type === 'rv.explore-code') {
    if (!ports.codeExplorer) {
      throw new PlatformError('denied', 'Explore code requires a source-repo explorer on the worker before planning.');
    }
    const explored: CodeExploreResult = await ports.codeExplorer.explore({
      application,
      workItem,
      criteria,
      maxFiles: 12,
      maxQueries: 6,
      executionId: step.runId,
      stepId: step.id,
    });
    const details = explored.details.map(({ path, excerpt, query }) => ({ path, excerpt, query }));
    const artifactMarkdown = renderExploreCodeMarkdown({
      workItem,
      application,
      findings: explored.findings,
      details: explored.details,
      repo: explored.repo,
    });
    return {
      summary: explored.summary,
      outputs: {
        findings: explored.findings,
        details,
        source: explored.source,
        repo: explored.repo,
        artifactMarkdown,
        artifactPath: exploreCodeArtifactPath(workItem, application),
      },
    };
  }

  if (step.type === 'rv.generate-test-plan' && ports.planner) {
    const planned: PlanResult = await ports.planner.plan({
      workItem,
      application,
      story: fullStory,
      criteria,
      findings: findings || undefined,
      executionId: step.runId,
      stepId: step.id,
    });
    return {
      summary: planned.summary,
      outputs: {
        scenarios: planned.scenarios,
        planMarkdown: planned.planMarkdown,
        planArtifact: planned.planArtifact,
        workItem,
        applicationName: application,
        environment,
        agent: 'playwright-test-planner',
        source: planned.source,
      },
    };
  }

  if (step.type === 'rv.generate-tests' && ports.generator) {
    const fromMd = planMarkdown ? parsePlanMarkdown(planMarkdown) : [];
    const source = scenarios.length > 0
      ? scenarios
      : fromMd.length > 0
        ? fromMd
        : (await (ports.planner?.plan({
          workItem,
          application,
          story: fullStory,
          criteria,
          findings: findings || undefined,
          executionId: step.runId,
          stepId: step.id,
        }) ?? { scenarios: [] })).scenarios;
    const generated: GenerateResult = await ports.generator.generate({
      workItem,
      application,
      scenarios: source,
      planMarkdown: planMarkdown || undefined,
      planArtifact: planArtifact || undefined,
      findings: findings || undefined,
      executionId: step.runId,
      stepId: step.id,
    });
    return {
      summary: generated.summary,
      outputs: {
        cases: generated.cases,
        workItem,
        planArtifact: planArtifact || undefined,
        agent: 'playwright-test-generator',
        source: generated.source,
      },
    };
  }

  if (step.type === 'rv.heal-tests' && ports.healer) {
    const cases = casesOf(step.prior.generate_tests?.cases);
    const healed: HealResult = await ports.healer.heal({
      workItem,
      application,
      cases,
      findings: findings || undefined,
      executionId: step.runId,
      stepId: step.id,
    });
    return {
      summary: healed.summary,
      outputs: {
        cases: healed.cases,
        fixed: healed.fixed,
        workItem,
        agent: 'playwright-test-healer',
        source: healed.source,
      },
    };
  }

  return runFlowStep(step);
}
