import { describe, expect, it } from 'vitest';
import { analyzeWorkItemStory, notificationTemplateScenarioSeeds } from '../src/story-scenarios';
import { generateHeuristically, planHeuristically } from '../src/heuristic';
import { isStubPlaywrightSource } from '../src/playwright-source';

const story2357 = [
  '2357',
  'Order Amount Placement in Escrow Notification Template',
  'Email subject: Your amount has been held in escrow.',
  'Greeting: Hi [Customer Name],',
  'Main message: order #[Order ID] from [Merchant], payment held in escrow until confirm delivery',
  'Order details table: Order ID, Merchant, Order Date, Paid Amount (dynamic)',
  'CTA: Confirm Delivery → secure PayNSure page; sub-text about browser',
  'Closing/support: support@paynsure.com, +94 77 123 4567, paynsure.com, © 2026 PayNSure Escrow',
  'Trigger: checkout + payment auth; Payment Status COMPLETED; email when order Placed',
  'Placeholders [...] from real-time DB',
].join('\n');

const shopFindings = [
  '- Explore: Title @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","Kitchen"; links="0 items in cart — go to order summary"; fields="Search products"',
  '- Explore: Greeting @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","Kitchen"; links="0 items in cart — go to order summary"; fields="Search products"',
].join('\n');

describe('story analysis 2357', () => {
  it('extracts search terms, surfaces, triggers, placeholders — not paynsure alone', () => {
    const a = analyzeWorkItemStory({
      story: story2357,
      criteria: ['Title', 'Greeting', 'Paid Amount', 'Confirm Delivery'],
      workItemTitle: 'Order Amount Placement in Escrow Notification Template',
      application: 'PayNSure',
    });
    expect(a.notificationTemplate).toBe(true);
    expect(a.searchTerms.some((t) => /escrow|notification|paid|delivery|amount/i.test(t))).toBe(true);
    expect(a.searchTerms.every((t) => t.toLowerCase() !== 'paynsure')).toBe(true);
    expect(a.surfaces.some((s) => /notification|email|template/i.test(s))).toBe(true);
    expect(a.triggers.some((t) => /COMPLETED|Placed/i.test(t))).toBe(true);
    expect(a.placeholders.length).toBeGreaterThan(0);
  });

  it('plans distinct story scenarios — not shop-catalog title variants', () => {
    const planned = planHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: story2357,
      criteria: ['Greeting', 'Paid Amount', 'Confirm Delivery'],
      findings: shopFindings,
    });
    expect(planned.exploreWarning).toMatch(/story|shop|Weak Explore|grounded/i);
    expect(planned.scenarios.some((s) => /subject|held in escrow/i.test(s.name))).toBe(true);
    expect(planned.scenarios.some((s) => /greeting|customer name/i.test(s.name))).toBe(true);
    expect(planned.scenarios.some((s) => /Paid Amount/i.test(s.name))).toBe(true);
    expect(planned.scenarios.some((s) => /Confirm Delivery/i.test(s.name))).toBe(true);
    expect(planned.scenarios.some((s) => /COMPLETED|Placed/i.test(s.name))).toBe(true);
    expect(planned.scenarios.every((s) => !/use Search control|Kitchen/i.test(s.name))).toBe(true);
  });

  it('generates needs-surface Blocked cases — not false shop passes for email ACs', () => {
    const planned = planHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: story2357,
      criteria: ['Paid Amount'],
      findings: shopFindings,
    });
    expect(planned.blockingGap).toBe(true);
    expect(planned.surfaceKind).toBe('template');
    expect(planned.planMarkdown).toMatch(/Explore surface gap \(blocking\)|needs-surface/i);
    const generated = generateHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: story2357,
      scenarios: planned.scenarios,
      findings: shopFindings,
    });
    expect(generated.cases.every((c) => !isStubPlaywrightSource(c.steps))).toBe(true);
    expect(generated.cases.every((c) => !/locator\(['"]body['"]\)\s*\)\s*\.toBeVisible/.test(c.steps))).toBe(true);
    const templateCases = generated.cases.filter((c) => /subject|greeting|Paid Amount|Confirm Delivery|support@|placeholder|held in escrow/i.test(c.name + c.expected));
    expect(templateCases.length).toBeGreaterThan(0);
    expect(templateCases.every((c) => c.runStatus === 'Blocked')).toBe(true);
    expect(templateCases.every((c) => c.tags?.includes('needs-surface'))).toBe(true);
    expect(templateCases.every((c) => /@qa-platform:needs-surface|test\.skip/i.test(c.steps))).toBe(true);
    expect(notificationTemplateScenarioSeeds({ story: story2357 }).length).toBeGreaterThan(5);
  });

  it('plans/generates template-field assertions when preview surface was explored', () => {
    const previewFindings = [
      '- Explore: escrow notification template / email preview (configured) @ http://email-preview-fixture/',
      '  title="Escrow notification email preview"; heading="Escrow notification template"; buttons="Confirm Delivery"; links="Confirm Delivery"',
      '- Story surface binding: kind=template; primary=http://email-preview-fixture/; templatePreview=http://email-preview-fixture/',
      '- Template preview surface reached: true (assert subject/greeting/table/CTA/Paid Amount from WI)',
    ].join('\n');
    const planned = planHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: story2357,
      criteria: ['Paid Amount', 'Greeting'],
      findings: previewFindings,
      templatePreviewUrl: 'http://email-preview-fixture/',
    });
    expect(planned.blockingGap).toBe(false);
    expect(planned.primarySurfaceUrl).toBe('http://email-preview-fixture/');
    expect(planned.exploreWarning).toMatch(/preview surface reached|Paid Amount|CTA/i);
    const generated = generateHeuristically({
      workItem: '2357',
      application: 'PayNSure',
      story: story2357,
      scenarios: planned.scenarios,
      findings: previewFindings,
      templatePreviewUrl: 'http://email-preview-fixture/',
    });
    const templateCases = generated.cases.filter((c) => /subject|greeting|Paid Amount|Confirm Delivery|held in escrow/i.test(c.name + c.expected));
    expect(templateCases.length).toBeGreaterThan(0);
    expect(templateCases.every((c) => c.runStatus !== 'Blocked')).toBe(true);
    expect(templateCases.some((c) => /email-preview-fixture|Paid Amount|Confirm Delivery|held in escrow|^Hi\\b/i.test(c.steps))).toBe(true);
  });
});
