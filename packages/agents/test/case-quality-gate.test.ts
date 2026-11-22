import { describe, expect, it } from 'vitest';
import {
  assertPublishQualityGate,
  criteriaFromPlanMarkdown,
  evaluateCaseQualityGate,
  renderAcCoverageMarkdown,
  renderPlanMarkdown,
} from '../src/index';

const realCase = {
  name: 'Positive: greeting shows Customer Name',
  steps: `import { test, expect } from '@playwright/test';
test('greeting', async ({ page }) => {
  await page.goto('https://preview.example/email');
  await expect(page.getByText('Hello')).toBeVisible();
});
`,
  expected: 'Greeting includes Customer Name',
  tags: [] as string[],
};

const stubCase = {
  name: 'Positive: stub',
  steps: `import { test, expect } from '@playwright/test';
test('x', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
});
`,
  expected: 'Ok',
};

describe('case quality gate', () => {
  it('refuses body-only stubs on publish assert', () => {
    const report = evaluateCaseQualityGate({ cases: [stubCase], criteria: ['Greeting shows Customer Name'] });
    expect(report.ok).toBe(false);
    expect(report.stubCount).toBe(1);
    expect(report.issues.some((i) => i.code === 'stub-forbidden' && i.severity === 'error')).toBe(true);
    expect(() => assertPublishQualityGate({ cases: [stubCase] })).toThrow(/quality gate|stub/i);
  });

  it('allows needs-surface cases with a warning', () => {
    const report = evaluateCaseQualityGate({
      cases: [{
        ...realCase,
        steps: `// @qa-platform:needs-surface Blocked\nimport { test } from '@playwright/test';\ntest('x', async () => { test.skip(true, 'gap'); });\n`,
        tags: ['needs-surface'],
        runStatus: 'Blocked',
      }],
      criteria: ['Greeting shows Customer Name'],
      blockingGap: true,
    });
    expect(report.ok).toBe(true);
    expect(report.needsSurfaceCount).toBe(1);
    expect(report.issues.some((i) => i.code === 'explore-gap' && i.severity === 'warning')).toBe(true);
  });

  it('flags AC coverage gaps without refusing publish', () => {
    const report = evaluateCaseQualityGate({
      cases: [realCase],
      criteria: [
        'Greeting shows Customer Name',
        'Unrelated criterion about refund policy that nothing covers',
      ],
      scenarios: [{
        name: realCase.name,
        kind: 'positive',
        priority: 'medium',
        criterion: 'Greeting shows Customer Name',
        steps: 'Open preview',
        expected: realCase.expected,
      }],
    });
    expect(report.ok).toBe(true);
    expect(report.acCoverage.filter((r) => !r.covered)).toHaveLength(1);
    expect(report.issues.some((i) => i.code === 'ac-coverage-gap')).toBe(true);
  });

  it('embeds AC coverage in plan Markdown', () => {
    const md = renderPlanMarkdown(
      [{
        name: 'Positive: Paid Amount',
        kind: 'positive',
        priority: 'high',
        criterion: 'Paid Amount is shown',
        steps: 'Open template',
        expected: 'Paid Amount visible',
      }],
      {
        workItem: '2357',
        application: 'PayNSure',
        criteria: ['Paid Amount is shown', 'CTA Confirm Delivery'],
      },
    );
    expect(md).toMatch(/## AC coverage/);
    expect(md).toMatch(/Gaps \(flagged\)/);
    expect(md).toMatch(/CTA Confirm Delivery/);
    expect(criteriaFromPlanMarkdown(md)).toEqual(expect.arrayContaining(['Paid Amount is shown', 'CTA Confirm Delivery']));
    expect(renderAcCoverageMarkdown([{ criterion: 'x', covered: false, scenarioNames: [] }])).toMatch(/Gaps/);
  });
});
