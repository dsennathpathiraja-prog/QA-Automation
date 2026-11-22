import { describe, expect, it } from 'vitest';
import {
  assessExplorationCoverage,
  buildMeaningfulPlaywrightSource,
  hasNearDuplicateExploreFindings,
  isStubPlaywrightSource,
  parseExplorationCues,
} from '../src/playwright-source';

const shopFindings = [
  '- Explore: Title @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","All items","Kitchen","Travel","Home","Desk"; links="0 items in cart — go to order summary"; fields="Search products"',
  '- Explore: Greeting: * Hi [Customer Name], @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","All items","Kitchen","Travel","Home","Desk"; links="0 items in cart — go to order summary"; fields="Search products"',
  '- Explore: Main Message: * Thank you for your order! @ http://sdk.paynsure.internal/shop (PayNSure Host App Simulator)',
  '  title="PayNSure Host App Simulator"; heading="All items"; buttons="Search","All items","Kitchen","Travel","Home","Desk"; links="0 items in cart — go to order summary"; fields="Search products"',
].join('\n');

describe('playwright-source', () => {
  it('parses shop explore cues', () => {
    const cues = parseExplorationCues(shopFindings);
    expect(cues.url).toBe('http://sdk.paynsure.internal/shop');
    expect(cues.headings[0]).toMatch(/All items/i);
    expect(cues.buttons).toContain('Search');
    expect(cues.fields).toContain('Search products');
  });

  it('detects near-duplicate explore rows across AC labels', () => {
    expect(hasNearDuplicateExploreFindings(shopFindings)).toBe(true);
    expect(hasNearDuplicateExploreFindings('- Explore: A @ https://a.example/x\n  buttons="One"\n- Explore: B @ https://b.example/y\n  buttons="Two"')).toBe(false);
  });

  it('flags template WI + duplicate shop as blocking secondary coverage', () => {
    const coverage = assessExplorationCoverage({
      findings: shopFindings,
      story: '2357\nOrder Amount Placement in Escrow Notification Template',
      criteria: ['Title', 'Greeting', 'Main Message', 'Paid Amount'],
    });
    expect(coverage.kind).toBe('secondary');
    expect(coverage.duplicateSurfaces).toBe(true);
    expect(coverage.shopSurface).toBe(true);
    expect(coverage.templateWorkItem).toBe(true);
    expect(coverage.blockingGap).toBe(true);
    expect(coverage.surfaceKind).toBe('template');
    expect(coverage.warning).toMatch(/Blocking explore gap|shop|template|needs-surface/i);
  });

  it('rejects body-only stubs', () => {
    const stub = "import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.locator('body')).toBeVisible();\n});\n";
    expect(isStubPlaywrightSource(stub)).toBe(true);
    const real = "import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.goto('/shop');\n  await page.getByRole('button', { name: 'Search' }).click();\n  await expect(page.getByText(/cart/i)).toBeVisible();\n});\n";
    expect(isStubPlaywrightSource(real)).toBe(false);
  });

  it('builds needs-surface skip instead of fake shop Greeting/catalog assertions', () => {
    const source = buildMeaningfulPlaywrightSource({
      scenario: {
        name: 'Positive: Order Amount Placement — Paid Amount placement in order details table',
        kind: 'positive',
        priority: 'medium',
        criterion: 'Paid Amount in escrow notification template',
        steps: 'Open order details table. Assert Paid Amount is dynamic.',
        expected: 'Paid Amount appears with live amount',
      },
      application: 'PayNSure',
      findings: shopFindings,
      story: 'Order Amount Placement in Escrow Notification Template',
      criteria: ['Paid Amount', 'Greeting'],
      index: 0,
    });
    expect(source).toMatch(/@qa-platform:needs-surface/);
    expect(source).toMatch(/test\.skip/);
    expect(source).not.toMatch(/locator\(['"]body['"]\)\s*\)\s*\.toBeVisible/);
    expect(source).not.toMatch(/getByRole\('button', \{ name: 'Kitchen'/);
    expect(source).not.toMatch(/Paid Amount appears with live amount/);
  });

  it('asserts Paid Amount / CTA against a reachable template preview URL', () => {
    const previewFindings = [
      '- Explore: escrow notification template / email preview (configured) @ http://email-preview-fixture/',
      '  title="Escrow notification email preview"; heading="Escrow notification template"; buttons="Confirm Delivery"; links="Confirm Delivery"; fields=""',
      '- Story surface binding: kind=template; primary=http://email-preview-fixture/; templatePreview=http://email-preview-fixture/',
      '- Template preview surface reached: true (assert subject/greeting/table/CTA/Paid Amount from WI)',
    ].join('\n');
    const coverage = assessExplorationCoverage({
      findings: previewFindings,
      story: 'Order Amount Placement in Escrow Notification Template',
      criteria: ['Paid Amount', 'Confirm Delivery'],
    });
    expect(coverage.blockingGap).toBe(false);
    expect(coverage.kind).toBe('strong');
    expect(coverage.primarySurfaceUrl).toMatch(/email-preview-fixture/);

    const paid = buildMeaningfulPlaywrightSource({
      scenario: {
        name: 'Positive: Paid Amount in order details table',
        kind: 'positive',
        priority: 'high',
        criterion: 'Paid Amount in escrow notification template',
        steps: 'Open template preview. Assert Paid Amount in the order details table.',
        expected: 'Paid Amount is visible with a live value',
      },
      application: 'PayNSure',
      findings: previewFindings,
      story: 'Order Amount Placement in Escrow Notification Template',
      criteria: ['Paid Amount'],
      index: 0,
    });
    expect(paid).toContain("page.goto('http://email-preview-fixture/')");
    expect(paid).toMatch(/Paid Amount/i);
    expect(paid).toMatch(/getByRole\('table'|order-details/i);
    expect(paid).not.toMatch(/@qa-platform:needs-surface/);

    const cta = buildMeaningfulPlaywrightSource({
      scenario: {
        name: 'Positive: Confirm Delivery CTA',
        kind: 'positive',
        priority: 'high',
        criterion: 'Confirm Delivery button',
        steps: 'Open template preview. Assert Confirm Delivery CTA.',
        expected: 'Confirm Delivery is visible',
      },
      application: 'PayNSure',
      findings: previewFindings,
      story: 'Order Amount Placement in Escrow Notification Template',
      criteria: ['Confirm Delivery'],
      index: 1,
    });
    expect(cta).toContain("page.goto('http://email-preview-fixture/')");
    expect(cta).toMatch(/Confirm Delivery/i);
    expect(cta).not.toMatch(/@qa-platform:needs-surface/);
  });
});
