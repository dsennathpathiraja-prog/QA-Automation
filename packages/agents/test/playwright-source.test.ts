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
});
