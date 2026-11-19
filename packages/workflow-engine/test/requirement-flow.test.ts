import { describe, expect, it } from 'vitest';
import { tick, type EngineStore } from '../src';
import { runFlowStep } from '../src/requirement-flow';

const story = 'QA-1\n\nAcceptance criteria\nThe saved card is listed\nThe total includes tax';

describe('requirement validation stages', () => {
  it('reads the criteria, plans scenarios, and keeps the cases out of Squash', () => {
    const params = { story, applicationName: 'checkout', environment: 'qa' };
    const read = runFlowStep({ id: 'read_story', type: 'rv.read-user-story', params, prior: {} });
    expect(read.outputs.acceptanceCriteria).toEqual(['The saved card is listed', 'The total includes tax']);
    const plan = runFlowStep({ id: 'plan', type: 'rv.generate-test-plan', params, prior: { read_story: read.outputs } });
    const generated = runFlowStep({ id: 'generate_tests', type: 'rv.generate-tests', params, prior: { read_story: read.outputs, plan: plan.outputs } });
    const cases = generated.outputs.cases as { name: string; workItem: string }[];
    expect(cases.map((item) => item.name)).toEqual(['The saved card is listed', 'The total includes tax']);
    expect(cases[0]?.workItem).toBe('QA-1');
    const published = runFlowStep({ id: 'publish_testcases', type: 'rv.publish-testcases', params, prior: { generate_tests: generated.outputs } });
    expect(published.summary).toMatch(/Test Cases/);
    expect(published.summary).toMatch(/read-only/);
    expect(published.outputs.squash).toBe('read-only');
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
