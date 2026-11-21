import { describe, expect, it } from 'vitest';
import { tick, type EngineStore } from '../src';
import { acceptanceLines, runFlowStep } from '../src/requirement-flow';

const story = 'QA-1\n\nAcceptance criteria\nThe saved card is listed\nThe total includes tax';

describe('requirement validation stages', () => {
  it('explores before planning, persists an MD plan, generates many cases, and heals', () => {
    const params = { story, applicationName: 'checkout', environment: 'qa' };
    const read = runFlowStep({ id: 'read_story', type: 'rv.read-user-story', params, prior: {} });
    expect(read.outputs.acceptanceCriteria).toEqual(['The saved card is listed', 'The total includes tax']);

    const explore = runFlowStep({ id: 'explore_ui', type: 'rv.explore-ui', params, prior: { read_story: read.outputs } });
    expect(explore.summary).toMatch(/before the plan|exploration/i);

    const consolidate = runFlowStep({
      id: 'consolidate',
      type: 'rv.consolidate-findings',
      params,
      prior: { read_story: read.outputs, explore_ui: explore.outputs },
    });
    expect(consolidate.outputs.findings).toBeTruthy();

    const plan = runFlowStep({
      id: 'plan',
      type: 'rv.generate-test-plan',
      params,
      prior: { read_story: read.outputs, consolidate: consolidate.outputs },
    });
    expect(plan.summary).toMatch(/playwright-test-planner/);
    expect(plan.summary).toMatch(/plan artifact/i);
    const scenarios = plan.outputs.scenarios as { name: string; kind: string; priority: string }[];
    expect(scenarios.length).toBeGreaterThan(6);
    expect(scenarios.some((s) => s.kind === 'positive')).toBe(true);
    expect(scenarios.some((s) => s.kind === 'negative')).toBe(true);
    expect(scenarios.some((s) => s.kind === 'edge')).toBe(true);
    expect(asText(plan.outputs.planMarkdown)).toMatch(/# Test plan: QA-1/);
    expect(asText(plan.outputs.planArtifact)).toMatch(/\.plan\.md$/);

    const generated = runFlowStep({
      id: 'generate_tests',
      type: 'rv.generate-tests',
      params,
      prior: { read_story: read.outputs, plan: plan.outputs, consolidate: consolidate.outputs },
    });
    expect(generated.summary).toMatch(/playwright-test-generator/);
    const cases = generated.outputs.cases as { name: string; workItem: string; steps: string; reference: string; kind: string; priority: string }[];
    expect(cases.length).toBe(scenarios.length);
    expect(cases[0]?.workItem).toBe('QA-1');
    expect(cases[0]?.steps).toMatch(/@playwright\/test/);
    expect(cases[0]?.reference).toMatch(/^QAP-/);

    const healed = runFlowStep({
      id: 'heal_tests',
      type: 'rv.heal-tests',
      params,
      prior: { generate_tests: generated.outputs },
    });
    expect(healed.summary).toMatch(/playwright-test-healer/);
    expect(healed.outputs.cases).toHaveLength(cases.length);

    const published = runFlowStep({
      id: 'publish_testcases',
      type: 'rv.publish-testcases',
      params,
      prior: { heal_tests: healed.outputs },
    });
    expect(published.summary).toMatch(/Squash/);
    expect(published.outputs.squash).toBe('read-write');
  });

  it('parses bullets and Given/When/Then from a work-item description blob', () => {
    const azureStyle = [
      '7189',
      'PayNSure checkout',
      '',
      'User can pay with a saved card.',
      '',
      'Acceptance Criteria',
      '- The saved card is listed on the payment page',
      '- The total includes tax',
      'Given a saved card',
      'When the shopper pays',
      'Then the receipt shows the card',
    ].join('\n');
    expect(acceptanceLines(azureStyle)).toEqual([
      'The saved card is listed on the payment page',
      'The total includes tax',
      'Given a saved card When the shopper pays Then the receipt shows the card',
    ]);
    const read = runFlowStep({ id: 'read_story', type: 'rv.read-user-story', params: { story: azureStyle, applicationName: 'PayNSure' }, prior: {} });
    expect(read.summary).toMatch(/3 acceptance criteria/);
    const plan = runFlowStep({
      id: 'plan',
      type: 'rv.generate-test-plan',
      params: { story: azureStyle, applicationName: 'PayNSure' },
      prior: { read_story: read.outputs },
    });
    expect((plan.outputs.scenarios as unknown[]).length).toBeGreaterThan(9);
    expect(asText(plan.outputs.planMarkdown)).toMatch(/7189/);
  });

  it('does not treat a bare work item id as acceptance criteria', () => {
    const read = runFlowStep({ id: 'read_story', type: 'rv.read-user-story', params: { story: '7189', applicationName: 'PayNSure' }, prior: {} });
    expect(read.outputs.acceptanceCriteria).toEqual([]);
    expect(read.summary).toMatch(/no separate acceptance criteria/);
  });
});

describe('workflow engine step notes', () => {
  it('records the step summary once', async () => {
    const events: { kind: string; payload: Record<string, unknown> }[] = [];
    const store: EngineStore = {
      async claim() {
        return { id: 'run-1', status: 'running', stepIndex: 0, phase: 'pending', control: null, definition: { spec: { steps: [{ id: 'read_story', type: 'rv.read-user-story' }] } }, params: { story: 'QA-1', applicationName: 'checkout' } };
      },
      async recordEffect() { return 'new'; },
      async save() { return undefined; },
      async append(_id, kind, payload) { events.push({ kind, payload }); },
      async stepsDone() { return []; },
    };
    expect(await tick(store, { owner: 'w', now: new Date(), perform: (step) => Promise.resolve(runFlowStep(step)) })).toBe('busy');
    expect(events.find((event) => event.kind === 'step.completed')?.payload.summary).toMatch(/QA-1/);
  });
});

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
