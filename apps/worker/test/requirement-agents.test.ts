import { describe, expect, it } from 'vitest';
import type { TestGeneratorPort, TestPlannerPort } from '@qa/agents';
import { performRequirementStep } from '../src/requirement-agents';

describe('performRequirementStep', () => {
  it('uses the planner port for rv.generate-test-plan', async () => {
    const planner: TestPlannerPort = {
      async plan(input) {
        return {
          summary: `planned ${input.workItem}`,
          source: 'model',
          scenarios: [{
            name: 'Positive: listed',
            kind: 'positive',
            priority: 'medium',
            criterion: 'listed',
            steps: 'Open and list',
            expected: 'Visible',
          }],
        };
      },
    };
    const out = await performRequirementStep(
      {
        id: 'plan',
        type: 'rv.generate-test-plan',
        runId: 'run-1',
        params: { story: '7189', applicationName: 'PayNSure' },
        prior: { read_story: { workItem: '7189', acceptanceCriteria: ['listed'], story: '7189\nlisted' } },
      },
      { planner },
    );
    expect(out.summary).toBe('planned 7189');
    expect(out.outputs.source).toBe('model');
    expect(out.outputs.scenarios).toHaveLength(1);
  });

  it('passes consolidation findings into the generator', async () => {
    let seenFindings: string | undefined;
    const generator: TestGeneratorPort = {
      async generate(input) {
        seenFindings = input.findings;
        return {
          summary: 'generated',
          source: 'heuristic',
          cases: [{
            name: input.scenarios[0]!.name,
            kind: 'positive',
            priority: 'medium',
            steps: "import { test, expect } from '@playwright/test';\n",
            expected: 'ok',
            workItem: input.workItem,
            reference: 'QAP-1',
            file: 'tests/a/b.spec.js',
            testId: 't1',
          }],
        };
      },
    };
    await performRequirementStep(
      {
        id: 'generate_tests',
        type: 'rv.generate-tests',
        runId: 'run-1',
        params: { applicationName: 'PayNSure' },
        prior: {
          read_story: { workItem: '7189', acceptanceCriteria: ['listed'] },
          plan: {
            scenarios: [{
              name: 'Positive: listed',
              kind: 'positive',
              priority: 'medium',
              criterion: 'listed',
              steps: 'Open',
              expected: 'Ok',
            }],
          },
          consolidate: { findings: 'UI: Pay button visible' },
        },
      },
      { generator },
    );
    expect(seenFindings).toMatch(/Pay button/);
  });
});
