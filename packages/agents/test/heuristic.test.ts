import { describe, expect, it } from 'vitest';
import { generateHeuristically, planHeuristically } from '../src/heuristic';
import { parsePlanMarkdown } from '../src/plan-markdown';
import { isStubPlaywrightSource } from '../src/playwright-source';

const shopFindings = [
  '- Explore: Title @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","All items","Kitchen"; links="0 items in cart — go to order summary"; fields="Search products"',
  '- Explore: Greeting @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","All items","Kitchen"; links="0 items in cart — go to order summary"; fields="Search products"',
  '- Explore: Paid Amount @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","All items","Kitchen"; links="0 items in cart — go to order summary"; fields="Search products"',
].join('\n');

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
    expect(planned.scenarios[0]?.name).toMatch(/^Positive: Pay with saved card/);
    expect(planned.scenarios.every((s) => /Pay with saved card/i.test(s.name))).toBe(true);
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

  it('flags duplicate shop explore and plans story themes — not catalog UI seeds', () => {
    const planned = planHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: '2357\nOrder Amount Placement in Escrow Notification Template\nPaid Amount\nConfirm Delivery\nHi [Customer Name],',
      criteria: ['Title', 'Greeting', 'Main Message', 'Paid Amount'],
      findings: shopFindings,
    });
    expect(planned.exploreWarning).toMatch(/story|shop|Weak Explore|grounded/i);
    expect(planned.planMarkdown).toMatch(/Explore coverage warning/);
    expect(planned.scenarios.some((s) => /Paid Amount|greeting|Confirm Delivery|held in escrow/i.test(s.name))).toBe(true);
    const uiSeeds = planned.scenarios.filter((s) => /use Search control for|Kitchen/i.test(s.name));
    expect(uiSeeds.length).toBe(0);
  });
});

describe('heuristic generator', () => {
  it('emits meaningful Playwright from explore cues (not body stubs)', () => {
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
      findings: 'Positive: … @ https://shop.example.com Pay button visible title="Shop"; heading="Checkout"; buttons="Pay"',
    });
    expect(generated.cases.length).toBe(planned.scenarios.length);
    expect(generated.cases[0]?.steps).toMatch(/@playwright\/test/);
    expect(generated.cases[0]?.validationSteps?.length).toBeGreaterThan(0);
    expect(generated.cases[0]?.reference).toMatch(/^QAP-/);
    expect(isStubPlaywrightSource(generated.cases[0]?.steps ?? '')).toBe(false);
    expect(generated.cases[0]?.steps).toMatch(/shop\.example\.com|getByRole/);
    expect(generated.cases.every((c) => !isStubPlaywrightSource(c.steps))).toBe(true);
  });

  it('generates story-grounded cases for WI 2357-style duplicate explore', () => {
    const planned = planHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: '2357\nOrder Amount Placement in Escrow Notification Template\nPaid Amount\nConfirm Delivery',
      criteria: ['Paid Amount'],
      findings: shopFindings,
    });
    const generated = generateHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      scenarios: planned.scenarios.slice(0, 5),
      findings: shopFindings,
    });
    const sources = generated.cases.map((c) => c.steps);
    expect(sources.every((s) => !isStubPlaywrightSource(s))).toBe(true);
    expect(sources.every((s) => !/locator\(['"]body['"]\)\s*\)\s*\.toBeVisible/.test(s))).toBe(true);
    expect(sources.some((s) => /held in escrow|Paid Amount|Confirm Delivery|Story-grounded/i.test(s))).toBe(true);
  });
});
