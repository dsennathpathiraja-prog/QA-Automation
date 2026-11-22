import { describe, expect, it } from 'vitest';
import { healHeuristically, isBrokenPlaywrightCase } from '../src/healer';
import { isStubPlaywrightSource } from '../src/playwright-source';
import type { GeneratedPlaywrightCase } from '../src/types';

const base = (overrides: Partial<GeneratedPlaywrightCase> = {}): GeneratedPlaywrightCase => ({
  name: 'Positive: listed',
  kind: 'positive',
  priority: 'medium',
  steps: "import { test, expect } from '@playwright/test';\ntest('Positive: listed', async ({ page }) => {\n  await page.goto('/');\n  await page.getByRole('button', { name: 'Pay' }).click();\n  await expect(page.getByText(/paid/i)).toBeVisible();\n});\n",
  expected: 'ok',
  workItem: '7189',
  reference: 'QAP-1',
  file: 'tests/a/b.spec.js',
  testId: 't1',
  ...overrides,
});

describe('playwright-test-healer', () => {
  it('leaves healthy cases alone', () => {
    const out = healHeuristically({ workItem: '7189', application: 'PayNSure', cases: [base()] });
    expect(out.fixed).toBe(0);
    expect(out.summary).toMatch(/none needed a fix/);
  });

  it('repairs stubs missing @playwright/test', () => {
    const broken = base({ steps: "test('x', async () => {});" });
    expect(isBrokenPlaywrightCase(broken)).toMatch(/missing/);
    const out = healHeuristically({ workItem: '7189', application: 'PayNSure', cases: [broken] });
    expect(out.fixed).toBe(1);
    expect(out.cases[0]?.steps).toMatch(/@playwright\/test/);
    expect(isStubPlaywrightSource(out.cases[0]?.steps ?? '')).toBe(false);
    expect(out.summary).toMatch(/playwright-test-healer/);
  });

  it('treats body-visibility-only stubs as broken and heals them', () => {
    const stub = base({
      steps: "import { test, expect } from '@playwright/test';\ntest('Positive: listed', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.locator('body')).toBeVisible();\n});\n",
    });
    expect(isBrokenPlaywrightCase(stub)).toMatch(/stub-only/i);
    const out = healHeuristically({
      workItem: '7189',
      application: 'PayNSure',
      cases: [stub],
      findings: '- Explore: x @ https://shop.example.com title="Shop"; heading="Checkout"; buttons="Pay"',
    });
    expect(out.fixed).toBe(1);
    expect(isStubPlaywrightSource(out.cases[0]?.steps ?? '')).toBe(false);
    expect(out.cases[0]?.steps).toMatch(/getByRole|shop\.example\.com/);
  });
});
