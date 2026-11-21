import { describe, expect, it } from 'vitest';
import { LlmGateway, StaticAssignmentResolver, StaticProviderRegistry, type ChatRequest, type ChatResult, type LlmPort, type ModelInfo } from '@qa/llm';
import { createLlmTestGenerator } from '../src/generator';
import { createLlmTestHealer } from '../src/healer';
import { PLAYWRIGHT_TEST_GENERATOR, PLAYWRIGHT_TEST_HEALER, PLAYWRIGHT_TEST_PLANNER } from '../src/heuristic';
import { createLlmTestPlanner } from '../src/planner';

class FakePort implements LlmPort {
  readonly adapter = 'fake';
  constructor(private readonly reply: string) {}
  async chat(_req: ChatRequest): Promise<ChatResult> {
    return { model: 'fake', content: this.reply, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } };
  }
  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'fake', supportsStructuredOutput: true }];
  }
  async health() {
    return { ok: true, latencyMs: 1 };
  }
}

function gateway(reply: string) {
  const port = new FakePort(reply);
  return new LlmGateway({
    registry: new StaticProviderRegistry([{
      descriptor: {
        id: 'local',
        kind: 'local',
        enabled: true,
        allowedDataClasses: ['story', 'code', 'page', 'screenshot', 'test-data', 'evidence'],
        concurrencySlots: 1,
        models: [{ name: 'fake', supportsStructuredOutput: true }],
      },
      port,
    }]),
    assignments: new StaticAssignmentResolver({
      [PLAYWRIGHT_TEST_PLANNER]: { primary: { providerId: 'local', model: 'fake' }, temperature: 0 },
      [PLAYWRIGHT_TEST_GENERATOR]: { primary: { providerId: 'local', model: 'fake' }, temperature: 0 },
      [PLAYWRIGHT_TEST_HEALER]: { primary: { providerId: 'local', model: 'fake' }, temperature: 0 },
    }),
    redactor: { redact: (s) => s },
    audit: { append: async () => undefined },
    profile: 'standard',
  });
}

describe('LLM planner / generator', () => {
  it('plans from structured model output', async () => {
    const planJson = JSON.stringify({
      scenarios: [
        { name: 'Positive: card listed', kind: 'positive', criterion: 'The saved card is listed', steps: 'Open PayNSure and list cards', expected: 'Card appears' },
        { name: 'Negative: reject invalid path for card listed', kind: 'negative', criterion: 'The saved card is listed', steps: 'Use a revoked card', expected: 'Blocked' },
        { name: 'Edge: boundary for card listed', kind: 'edge', criterion: 'The saved card is listed', steps: 'Only one card on file', expected: 'Still listed' },
      ],
    });
    const planner = createLlmTestPlanner(gateway(planJson));
    const out = await planner.plan({
      workItem: '7189',
      application: 'PayNSure',
      story: '7189\nThe saved card is listed',
      criteria: ['The saved card is listed'],
    });
    expect(out.source).toBe('model');
    expect(out.scenarios).toHaveLength(3);
    expect(out.summary).toMatch(/with a model/);
    expect(out.summary).toMatch(/plan artifact/i);
    expect(out.planMarkdown).toMatch(/# Test plan: 7189/);
    expect(out.scenarios[1]?.priority).toBe('high');
  });

  it('generates Playwright cases from structured model output', async () => {
    const genJson = JSON.stringify({
      cases: [{
        name: 'Positive: card listed',
        kind: 'positive',
        steps: "import { test, expect } from '@playwright/test';\ntest('Positive: card listed', async ({ page }) => { await page.goto('/'); });\n",
        expected: 'Card appears',
      }],
    });
    const generator = createLlmTestGenerator(gateway(genJson));
    const out = await generator.generate({
      workItem: '7189',
      application: 'PayNSure',
      scenarios: [{
        name: 'Positive: card listed',
        kind: 'positive',
        priority: 'medium',
        criterion: 'The saved card is listed',
        steps: 'Open',
        expected: 'Ok',
      }],
      findings: 'Pay button on /checkout',
    });
    expect(out.source).toBe('model');
    expect(out.cases[0]?.steps).toMatch(/@playwright\/test/);
    expect(out.cases[0]?.workItem).toBe('7189');
  });

  it('falls back to heuristics when no gateway is configured', async () => {
    const planner = createLlmTestPlanner(undefined);
    const out = await planner.plan({
      workItem: '1',
      application: 'App',
      story: '1',
      criteria: ['User can sign in'],
    });
    expect(out.source).toBe('heuristic');
    expect(out.scenarios.length).toBeGreaterThan(3);
    expect(out.scenarios.some((s) => /password|credentials/i.test(s.steps))).toBe(true);
  });

  it('heals broken cases through the LLM healer port', async () => {
    const healJson = JSON.stringify({
      cases: [{
        name: 'Positive: card listed',
        kind: 'positive',
        steps: "import { test, expect } from '@playwright/test';\ntest('Positive: card listed', async ({ page }) => { await page.goto('/'); await expect(page.locator('body')).toBeVisible(); });\n",
        expected: 'Card appears',
      }],
    });
    const healer = createLlmTestHealer(gateway(healJson));
    const out = await healer.heal({
      workItem: '7189',
      application: 'PayNSure',
      cases: [{
        name: 'Positive: card listed',
        kind: 'positive',
        priority: 'medium',
        steps: 'broken',
        expected: 'Card appears',
        workItem: '7189',
        reference: 'QAP-1',
        file: 'tests/a.spec.js',
        testId: 't1',
      }],
    });
    expect(out.source).toBe('model');
    expect(out.fixed).toBe(1);
    expect(out.cases[0]?.steps).toMatch(/@playwright\/test/);
  });
});
