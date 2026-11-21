import { describe, expect, it } from 'vitest';
import { generateHeuristically, planHeuristically } from '../src/heuristic';
import { parsePlanMarkdown } from '../src/plan-markdown';

describe('description-aware heuristic planner', () => {
  it('writes many Positive / Negative / Edge cases from payment criteria wording', () => {
    const planned = planHeuristically({
      workItem: '7189',
      application: 'PayNSure',
      story: '7189\nPay with saved card\nAcceptance criteria\nThe saved card is listed\nThe total includes tax',
      criteria: ['The saved card is listed', 'The total includes tax'],
    });
    expect(planned.source).toBe('heuristic');
    expect(planned.scenarios.length).toBeGreaterThan(6);
    expect(planned.planMarkdown).toMatch(/# Test plan: 7189/);
    expect(planned.planArtifact).toMatch(/\.plan\.md$/);
    expect(planned.scenarios[0]?.name).toMatch(/^Positive:/);
    expect(planned.scenarios.some((s) => /declined card|missing CVV|unauthorized/i.test(s.steps))).toBe(true);
    expect(planned.scenarios.some((s) => /saved card|expired card|boundary|alternate|zero amount/i.test(s.steps))).toBe(true);
    const parsed = parsePlanMarkdown(planned.planMarkdown);
    expect(parsed.length).toBe(planned.scenarios.length);
  });

  it('seeds extra Description paths beyond acceptance criteria', () => {
    const planned = planHeuristically({
      workItem: '7189',
      application: 'PayNSure',
      story: [
        '7189',
        'Shoppers can pay with a wallet.',
        'Acceptance criteria',
        'The wallet balance is shown',
        'Receipt emails are optional for guests',
      ].join('\n'),
      criteria: ['The wallet balance is shown'],
      findings: 'UI: Wallet button on /checkout',
    });
    expect(planned.scenarios.length).toBeGreaterThan(3);
    expect(planned.planMarkdown).toMatch(/Exploration findings/);
    expect(planned.planMarkdown).toMatch(/Wallet button/);
  });
});

describe('heuristic generator', () => {
  it('embeds exploration findings in the Playwright stub', () => {
    const planned = planHeuristically({
      workItem: 'QA-1',
      application: 'checkout',
      story: 'QA-1',
      criteria: ['The saved card is listed'],
    });
    const generated = generateHeuristically({
      workItem: 'QA-1',
      application: 'checkout',
      scenarios: planned.scenarios,
      planMarkdown: planned.planMarkdown,
      findings: 'Positive: … @ https://shop.example.com Pay button visible',
    });
    expect(generated.cases.length).toBe(planned.scenarios.length);
    expect(generated.cases[0]?.steps).toMatch(/@playwright\/test/);
    expect(generated.cases[0]?.steps).toMatch(/Exploration:.*Pay button/);
    expect(generated.cases[0]?.reference).toMatch(/^QAP-/);
  });
});
