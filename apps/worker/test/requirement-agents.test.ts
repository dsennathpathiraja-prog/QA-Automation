import { describe, expect, it } from 'vitest';
import type { BrowserExplorerPort, CodeExplorerPort, TestGeneratorPort, TestHealerPort, TestPlannerPort } from '@qa/agents';
import { performRequirementStep } from '../src/requirement-agents';

describe('performRequirementStep', () => {
  it('resolves the environment URL and drives explore_ui before planning', async () => {
    let seenUrl: string | undefined;
    const explorer: BrowserExplorerPort = {
      async explore(input) {
        seenUrl = input.url;
        return {
          summary: `opened ${input.url}`,
          findings: `page @ ${input.url}`,
          details: [{ scenarioName: 'home', url: input.url ?? '', snapshotExcerpt: 'button Pay' }],
          source: 'browser',
        };
      },
    };
    const out = await performRequirementStep(
      {
        id: 'explore_ui',
        type: 'rv.explore-ui',
        runId: 'run-1',
        params: { applicationName: 'PayNSure', environment: 'env-qa' },
        prior: { read_story: { workItem: '7189', acceptanceCriteria: ['listed'] } },
      },
      {
        explorer,
        resolveEnvironmentUrl: async (id) => (id === 'env-qa' ? 'https://qa.shop.example/' : undefined),
      },
    );
    expect(seenUrl).toBe('https://qa.shop.example/');
    expect(out.summary).toMatch(/opened|Visited/);
    expect(out.outputs.source).toBe('browser');
    expect(out.outputs.findings).toMatch(/qa\.shop\.example/);
  });

  it('drives explore_code through the source-repo explorer before planning', async () => {
    const codeExplorer: CodeExplorerPort = {
      async explore(input) {
        return {
          summary: `Visited files: src/pay.ts for ${input.application} before planning.`,
          findings: '- src/pay.ts\n  export function pay()',
          details: [{ path: 'src/pay.ts', excerpt: 'export function pay()' }],
          source: 'repo',
        };
      },
    };
    const out = await performRequirementStep(
      {
        id: 'explore_code',
        type: 'rv.explore-code',
        runId: 'run-1',
        params: { applicationName: 'PayNSure' },
        prior: { read_story: { workItem: '7189', acceptanceCriteria: ['pay'] } },
      },
      { codeExplorer },
    );
    expect(out.summary).toMatch(/Visited files: src\/pay\.ts/);
    expect(out.outputs.source).toBe('repo');
    expect(out.outputs.findings).toMatch(/pay\.ts/);
  });

  it('uses the planner port for rv.generate-test-plan and persists MD outputs', async () => {
    const planner: TestPlannerPort = {
      async plan(input) {
        return {
          summary: `planned ${input.workItem}`,
          source: 'model',
          planMarkdown: `# Test plan: ${input.workItem}\n\n## Scenarios\n\n### 1. Positive: listed\n\n- **Kind:** positive\n- **Priority:** medium\n- **Criterion:** listed\n- **Steps:** Open and list\n- **Expected:** Visible\n`,
          planArtifact: 'plans/paynsure/7189.plan.md',
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
        prior: {
          read_story: { workItem: '7189', acceptanceCriteria: ['listed'], story: '7189\nlisted' },
          consolidate: { findings: 'UI: Pay button' },
        },
      },
      { planner },
    );
    expect(out.summary).toBe('planned 7189');
    expect(out.outputs.source).toBe('model');
    expect(out.outputs.planArtifact).toMatch(/\.plan\.md$/);
    expect(out.outputs.planMarkdown).toMatch(/Test plan/);
    expect(out.outputs.scenarios).toHaveLength(1);
  });

  it('passes consolidation findings and MD plan into the generator', async () => {
    let seenFindings: string | undefined;
    let seenMarkdown: string | undefined;
    const generator: TestGeneratorPort = {
      async generate(input) {
        seenFindings = input.findings;
        seenMarkdown = input.planMarkdown;
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
            planMarkdown: '# Test plan',
            planArtifact: 'plans/x.plan.md',
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
    expect(seenMarkdown).toMatch(/Test plan/);
  });

  it('uses the healer port for rv.heal-tests', async () => {
    const healer: TestHealerPort = {
      async heal(input) {
        return {
          summary: `healed ${input.cases.length}`,
          source: 'heuristic',
          fixed: 1,
          cases: input.cases,
        };
      },
    };
    const out = await performRequirementStep(
      {
        id: 'heal_tests',
        type: 'rv.heal-tests',
        runId: 'run-1',
        params: { applicationName: 'PayNSure' },
        prior: {
          read_story: { workItem: '7189' },
          generate_tests: {
            cases: [{
              name: 'Positive: listed',
              kind: 'positive',
              priority: 'medium',
              steps: "import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => { await expect(page.locator('body')).toBeVisible(); });\n",
              expected: 'ok',
              workItem: '7189',
              reference: 'QAP-1',
              file: 'tests/a/b.spec.js',
              testId: 't1',
            }],
          },
        },
      },
      { healer },
    );
    expect(out.summary).toBe('healed 1');
    expect(out.outputs.fixed).toBe(1);
    expect(out.outputs.agent).toBe('playwright-test-healer');
  });
});
