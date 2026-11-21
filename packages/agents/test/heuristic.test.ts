import { describe, expect, it } from 'vitest';
import { generateHeuristically, planHeuristically } from '../src/heuristic';

describe('description-aware heuristic planner', () => {
  it('writes Positive / Negative / Edge cases from payment criteria wording', () => {
    const planned = planHeuristically({
      workItem: '7189',
      application: 'PayNSure',
      story: '7189\nPay with saved card\nAcceptance criteria\nThe saved card is listed\nThe total includes tax',
      criteria: ['The saved card is listed', 'The total includes tax'],
    });
    expect(planned.source).toBe('heuristic');
    expect(planned.scenarios).toHaveLength(6);
    expect(planned.scenarios[0]?.name).toMatch(/^Positive:/);
    expect(planned.scenarios[1]?.steps).toMatch(/declined card|missing CVV|unauthorized/i);
    expect(planned.scenarios[2]?.steps).toMatch(/saved card|expired card|boundary|alternate/i);
    expect(planned.scenarios[5]?.expected).toMatch(/tax|amount|boundary/i);
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
      findings: 'Positive: … @ https://shop.example.com Pay button visible',
    });
    expect(generated.cases[0]?.steps).toMatch(/@playwright\/test/);
    expect(generated.cases[0]?.steps).toMatch(/Exploration:.*Pay button/);
    expect(generated.cases[0]?.reference).toMatch(/^QAP-/);
  });
});
