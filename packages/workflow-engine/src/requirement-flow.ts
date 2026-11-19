export interface FlowStep {
  id: string;
  type: string;
  params: Record<string, unknown>;
  prior: Record<string, Record<string, unknown>>;
}

export interface FlowCase {
  name: string;
  steps: string;
  expected: string;
  workItem: string;
}

export interface FlowResult {
  summary: string;
  outputs: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Lines under an "Acceptance criteria" heading, or every non-empty line when there is no heading. */
export function acceptanceLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /acceptance criteria/i.test(line));
  const body = (start >= 0 ? lines.slice(start + 1) : lines).map((line) => line.replace(/^[\s>*\-•\d.)]+/, '').trim()).filter((line) => line.length > 0);
  const kept: string[] = [];
  for (const line of body) {
    if (start >= 0 && /^#{1,6}\s/.test(line)) break;
    kept.push(line);
  }
  return kept.slice(0, 40);
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : []);

const casesOf = (value: unknown): FlowCase[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Partial<FlowCase>;
    const name = text(row.name);
    const steps = text(row.steps);
    const expected = text(row.expected);
    if (!name || !steps || !expected) return [];
    return [{ name, steps, expected, workItem: text(row.workItem) }];
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
  const workItem = text(storyOut.workItem) || story.split(/\r?\n/)[0]?.slice(0, 80) || 'work-item';
  const scenarios = list(step.prior.plan?.scenarios);
  const cases = casesOf(step.prior.generate_tests?.cases);

  switch (step.type) {
    case 'rv.read-user-story': {
      const found = acceptanceLines(story);
      const single = found.length === 1 && found[0] === story;
      const acceptanceCriteria = single ? [] : found;
      return {
        summary: acceptanceCriteria.length > 0
          ? `Read work item ${workItem}. ${acceptanceCriteria.length} acceptance criteria.`
          : `Read work item ${workItem || '(none)'}. The story text has no separate acceptance criteria, so the plan uses the work item itself.`,
        outputs: { story, workItem, acceptanceCriteria, applicationName: application, environment },
      };
    }
    case 'rv.generate-test-plan': {
      const source = criteria.length > 0 ? criteria : [workItem ? `Verify ${application} for ${workItem}` : `Verify ${application}`];
      return {
        summary: `Test plan has ${source.length} scenario${source.length === 1 ? '' : 's'} from the story.`,
        outputs: { scenarios: source, workItem, applicationName: application, environment },
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
    case 'rv.consolidate-findings':
      return {
        summary: `Combined the story, the UI note, and the source note. ${scenarios.length || criteria.length || 1} scenario${(scenarios.length || criteria.length) === 1 ? '' : 's'} go forward.`,
        outputs: { scenarios: scenarios.length > 0 ? scenarios : criteria, workItem },
      };
    case 'rv.generate-tests': {
      const source = scenarios.length > 0 ? scenarios : criteria.length > 0 ? criteria : [`Verify ${application} for ${workItem}`];
      const generated: FlowCase[] = source.slice(0, 40).map((line) => ({
        name: line.slice(0, 120),
        steps: `1. Open ${application}.\n2. Follow the requirement: ${line}`,
        expected: line,
        workItem,
      }));
      return {
        summary: `Generated ${generated.length} test case${generated.length === 1 ? '' : 's'} for ${workItem}.`,
        outputs: { cases: generated, workItem },
      };
    }
    case 'rv.publish-testcases':
      return {
        summary: cases.length > 0
          ? `Stored ${cases.length} test case${cases.length === 1 ? '' : 's'} for ${workItem} in Test Cases. This Squash connection is read-only, so they were not added in Squash.`
          : `No test cases were generated for ${workItem}. Nothing was sent to Squash.`,
        outputs: { cases, workItem, squash: 'read-only' },
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
        summary: 'Results stay on this execution. Squash was not updated because this connection is read-only.',
        outputs: { squash: 'read-only' },
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
