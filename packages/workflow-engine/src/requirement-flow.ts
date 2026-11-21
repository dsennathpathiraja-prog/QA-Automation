import { generateWithPlaywrightGenerator, planWithPlaywrightPlanner, type PlannerScenario } from './playwright-agents';

export interface FlowStep {
  id: string;
  type: string;
  params: Record<string, unknown>;
  prior: Record<string, Record<string, unknown>>;
}

export interface FlowCase {
  name: string;
  kind: PlannerScenario['kind'];
  priority: PlannerScenario['priority'];
  steps: string;
  expected: string;
  workItem: string;
  reference: string;
  file: string;
  testId: string;
}

export interface FlowResult {
  summary: string;
  outputs: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const stripBullet = (line: string) => line.replace(/^[\s>*\-•\d.)]+/, '').trim();

const isSectionHeading = (line: string) => /^(#{1,6}\s|acceptance criteria\b|repro(duction)? steps\b|description\b|notes?\b|business rules?\b)/i.test(line.trim());

const isGwt = (line: string) => /^(given|when|then|and)\b/i.test(line);

/** First non-empty line is treated as the work item id when it looks like one. */
export function workItemIdFromStory(raw: string): string {
  const first = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  if (/^\d{1,10}$/.test(first) || /^[A-Z][A-Z0-9]+-\d+$/i.test(first)) return first;
  return first.slice(0, 80);
}

/**
 * Lines under an "Acceptance criteria" heading, Given/When/Then blocks, or bullets.
 * The work-item id on the first line is never treated as a criterion by itself.
 */
export function acceptanceLines(raw: string): string[] {
  const lines = raw.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((line) => /acceptance criteria/i.test(line));
  const bodyLines = (start >= 0 ? lines.slice(start + 1) : lines).map((line) => line.trim());
  const kept: string[] = [];
  let gwt: string[] = [];
  const flushGwt = () => {
    if (gwt.length === 0) return;
    kept.push(gwt.join(' '));
    gwt = [];
  };
  for (const rawLine of bodyLines) {
    if (!rawLine) continue;
    if (start >= 0 && /^#{1,6}\s/.test(rawLine)) break;
    const line = stripBullet(rawLine);
    if (!line) continue;
    if (isSectionHeading(line) && !isGwt(line)) {
      flushGwt();
      continue;
    }
    if (isGwt(line)) {
      if (/^given\b/i.test(line) && gwt.length > 0) flushGwt();
      gwt.push(line);
      if (/^then\b/i.test(line)) flushGwt();
      continue;
    }
    flushGwt();
    kept.push(line);
  }
  flushGwt();

  const workItem = workItemIdFromStory(raw);
  const withoutId = kept.filter((line) => line !== workItem && line.toLowerCase() !== 'acceptance criteria');
  if (withoutId.length > 0) return withoutId.slice(0, 40);

  // No AC heading: prefer bullets / GWT from the whole story, skipping the id line.
  const cues: string[] = [];
  gwt = [];
  for (const rawLine of lines.map((line) => line.trim()).filter(Boolean)) {
    const line = stripBullet(rawLine);
    if (!line || line === workItem || isSectionHeading(line) && !isGwt(line)) {
      if (gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      continue;
    }
    if (isGwt(line)) {
      if (/^given\b/i.test(line) && gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      gwt.push(line);
      if (/^then\b/i.test(line)) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      continue;
    }
    if (/^([\-*•]|\d+[.)])\s+\S/.test(rawLine) || start < 0 && line.length >= 12 && line !== workItem) {
      if (gwt.length > 0) {
        cues.push(gwt.join(' '));
        gwt = [];
      }
      cues.push(line);
    }
  }
  if (gwt.length > 0) cues.push(gwt.join(' '));
  return cues.slice(0, 40);
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []);

const priorityOf = (kind: PlannerScenario['kind'], raw: unknown): PlannerScenario['priority'] => {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
};

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
    return [{ name, kind, priority: priorityOf(kind, row.priority), criterion, steps, expected }];
  });
};

const casesOf = (value: unknown): FlowCase[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Partial<FlowCase>;
    const name = text(row.name);
    const steps = text(row.steps);
    const expected = text(row.expected);
    if (!name || !steps || !expected) return [];
    const kind = row.kind === 'negative' || row.kind === 'edge' ? row.kind : 'positive';
    return [{
      name,
      kind,
      priority: priorityOf(kind, row.priority),
      steps,
      expected,
      workItem: text(row.workItem),
      reference: text(row.reference),
      file: text(row.file),
      testId: text(row.testId),
    }];
  });
};

/**
 * One requirement-validation stage. The story text is the source of the plan.
 * UI and source notes are recorded; this function does not call a browser, a repository, or Squash.
 */
export function runFlowStep(step: FlowStep): FlowResult {
  const story = text(step.params.story);
  const application = text(step.params.applicationName) || 'the application';
  const environment = text(step.params.environment);
  const storyOut = step.prior.read_story ?? {};
  const criteria = list(storyOut.acceptanceCriteria);
  const workItem = text(storyOut.workItem) || workItemIdFromStory(story) || 'work-item';
  const scenarios = scenariosOf(step.prior.plan?.scenarios);
  const cases = casesOf(step.prior.generate_tests?.cases);

  switch (step.type) {
    case 'rv.read-user-story': {
      const found = acceptanceLines(story);
      const onlyId = found.length === 0 || (found.length === 1 && found[0] === workItem);
      const acceptanceCriteria = onlyId ? [] : found;
      return {
        summary: acceptanceCriteria.length > 0
          ? `Read work item ${workItem}. ${acceptanceCriteria.length} acceptance criteria.`
          : `Read work item ${workItem || '(none)'}. The story text has no separate acceptance criteria, so the plan uses the work item itself.`,
        outputs: { story, workItem, acceptanceCriteria, applicationName: application, environment },
      };
    }
    case 'rv.generate-test-plan': {
      const planned = planWithPlaywrightPlanner({ workItem, application, criteria });
      return {
        summary: planned.summary,
        outputs: { scenarios: planned.scenarios, workItem, applicationName: application, environment, agent: 'playwright-test-planner' },
      };
    }
    case 'rv.explore-ui':
      return {
        summary: environment
          ? `UI note for ${application} on ${environment}: the scenarios stay in the plan. This run does not drive the browser.`
          : 'UI note: no environment was given, so the screen was not opened.',
        outputs: { findings: environment ? `environment ${environment}` : 'no environment' },
      };
    case 'rv.explore-code':
      return {
        summary: 'Source note: the scenarios stay in the plan. This run does not read the repository.',
        outputs: { findings: 'repository not read' },
      };
    case 'rv.consolidate-findings': {
      const ui = text(step.prior.explore_ui?.findings);
      const code = text(step.prior.explore_code?.findings);
      const combined = [ui && `UI: ${ui}`, code && `Source: ${code}`].filter(Boolean).join('\n') || 'no exploration findings';
      return {
        summary: `Combined the story, the UI note, and the source note. ${scenarios.length || criteria.length || 1} scenario${(scenarios.length || criteria.length) === 1 ? '' : 's'} go forward.`,
        outputs: { scenarios: scenarios.length > 0 ? scenarios : criteria, workItem, findings: combined, combined },
      };
    }
    case 'rv.generate-tests': {
      const source = scenarios.length > 0 ? scenarios : planWithPlaywrightPlanner({ workItem, application, criteria }).scenarios;
      const findings = text(step.prior.consolidate?.findings) || text(step.prior.consolidate?.combined) || text(step.prior.explore_ui?.findings);
      const generated = generateWithPlaywrightGenerator({ workItem, application, scenarios: source, findings });
      return {
        summary: generated.summary,
        outputs: { cases: generated.cases, workItem, agent: 'playwright-test-generator' },
      };
    }
    case 'rv.publish-testcases':
      return {
        summary: cases.length > 0
          ? `Ready to store ${cases.length} test case${cases.length === 1 ? '' : 's'} for ${workItem} in Test Cases and in Squash.`
          : `No test cases were generated for ${workItem}. Nothing was sent to Squash.`,
        outputs: { cases, workItem, squash: 'read-write' },
      };
    case 'rv.execute-tests':
      return {
        summary: cases.length > 0
          ? `Recorded ${cases.length} case${cases.length === 1 ? '' : 's'} for execution under ${workItem}. Screenshots are not captured in this run.`
          : `No cases to execute for ${workItem}.`,
        outputs: { results: cases.map((item) => ({ name: item.name, status: 'recorded', workItem })) },
      };
    case 'rv.sync-results':
      return {
        summary: 'Execution results stay on this run. The generated test cases are stored in Squash when the publish step runs.',
        outputs: { squash: 'read-write' },
      };
    case 'rv.qa-report':
      return {
        summary: cases.length > 0
          ? `Report: ${cases.length} test case${cases.length === 1 ? '' : 's'} for ${workItem} are in Test Cases.`
          : `Report: no test cases were stored for ${workItem}.`,
        outputs: { workItem, count: cases.length },
      };
    default:
      return { summary: `Recorded ${step.id}.`, outputs: {} };
  }
}
