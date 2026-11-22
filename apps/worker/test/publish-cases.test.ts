import { describe, expect, it } from 'vitest';
import { AutomationService, TestCaseService } from '@qa/application';
import { InMemoryAuditSink, InMemoryAutomationRepository, InMemoryTestCaseRepository } from '@qa/testing';
import { publishGeneratedCases } from '../src/publish-cases';

const cases = [{
  name: 'Positive: checkout',
  steps: "import { test } from '@playwright/test';\n",
  expected: 'Ok',
  workItem: '7259',
  reference: 'QAP-7259-1',
  kind: 'positive' as const,
  priority: 'medium' as const,
  validationSteps: [{ action: 'Open checkout', expected: 'Ok' }],
  file: 'tests/app/7259.spec.js',
}];

describe('publishGeneratedCases', () => {
  it('names the Squash project and ids when store succeeds', async () => {
    const testCases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const out = await publishGeneratedCases({
      workItem: '7259',
      cases,
      testCases,
      squash: async () => ({ id: '42', created: true, projectId: '7' }),
    });
    expect(out.summary).toMatch(/Squash project 7/);
    expect(out.summary).toMatch(/QAP-7259-1/);
    expect(out.summary).toMatch(/Squash ids: 42/);
  });

  it('passes meaningful name, description, and action steps to Squash', async () => {
    const testCases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    let seen: { reference: string; name: string; description: string; steps: { action: string; expected: string }[] } | undefined;
    await publishGeneratedCases({
      workItem: '7259',
      cases,
      testCases,
      squash: async (_item, upsert) => {
        seen = upsert;
        return { id: '42', created: true, projectId: '7' };
      },
    });
    expect(seen).toMatchObject({
      reference: 'QAP-7259-1',
      name: 'Positive: checkout',
      steps: [{ action: 'Open checkout', expected: 'Ok' }],
    });
    expect(seen?.description).toMatch(/Kind: positive/);
    expect(seen?.description).toMatch(/Work item: 7259/);
    expect(seen?.description).toMatch(/tests\/app\/7259\.spec\.js/);
  });

  it('re-publishes the same reference without duplicating platform cases', async () => {
    const repo = new InMemoryTestCaseRepository();
    const testCases = new TestCaseService({ cases: repo, audit: new InMemoryAuditSink() });
    const squash = async () => ({ id: '42', created: false, projectId: '7' });
    await publishGeneratedCases({ workItem: '7259', cases, testCases, squash });
    await publishGeneratedCases({
      workItem: '7259',
      cases: [{ ...cases[0]!, name: 'Positive: Positive', steps: 'Open again', expected: 'Still ok' }],
      testCases,
      squash,
    });
    expect(await testCases.list()).toHaveLength(1);
    expect((await testCases.list())[0]).toMatchObject({ name: 'Positive: Positive', version: 2, summary: 'Squash 42' });
  });

  it('explains a missing workflow binding', async () => {
    const testCases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const { PlatformError } = await import('@qa/domain');
    const out = await publishGeneratedCases({
      workItem: '7259',
      cases,
      testCases,
      squash: async () => { throw new PlatformError('denied', 'role testManagement is not bound for this execution'); },
    });
    expect(out.summary).toMatch(/No Squash connector is bound/);
  });

  it('keeps the READ-only token message from Squash instead of the connector read-only hint', async () => {
    const testCases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const { PlatformError } = await import('@qa/domain');
    const out = await publishGeneratedCases({
      workItem: '7259',
      cases,
      testCases,
      squash: async () => {
        throw new PlatformError(
          'auth',
          'SquashTM refused the write because this token is READ-only. Create a READ_WRITE personal token, replace credentials on the same Squash connector, Test Connection, Switch on, restart the worker if it was already running, and run again.',
        );
      },
    });
    expect(out.summary).toMatch(/token is READ-only/);
    expect(out.summary).not.toMatch(/migration 0010/);
  });

  it('refuses body-only stub cases before writing Test Cases or Squash', async () => {
    const repo = new InMemoryTestCaseRepository();
    const testCases = new TestCaseService({ cases: repo, audit: new InMemoryAuditSink() });
    let squashCalls = 0;
    await expect(publishGeneratedCases({
      workItem: '7259',
      cases: [{
        name: 'Positive: stub',
        steps: "import { test, expect } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.goto('/');\n  await expect(page.locator('body')).toBeVisible();\n});\n",
        expected: 'Ok',
        workItem: '7259',
        reference: 'QAP-7259-stub',
      }],
      testCases,
      squash: async () => {
        squashCalls += 1;
        return { id: '99', created: true, projectId: '7' };
      },
    })).rejects.toThrow(/quality gate|stub/i);
    expect(await testCases.list()).toHaveLength(0);
    expect(squashCalls).toBe(0);
  });

  it('publishes needs-surface cases and notes the quality gate', async () => {
    const testCases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const out = await publishGeneratedCases({
      workItem: '2357',
      cases: [{
        name: 'Positive: greeting (needs surface)',
        steps: "// @qa-platform:needs-surface\nimport { test } from '@playwright/test';\ntest('g', async () => { test.skip(true, 'gap'); });\n",
        expected: 'Blocked until template preview exists',
        workItem: '2357',
        reference: 'QAP-2357-1',
        runStatus: 'Blocked',
        tags: ['needs-surface'],
      }],
      testCases,
      criteria: ['Greeting shows Customer Name', 'Totally uncovered AC about SMS'],
      blockingGap: true,
      squash: async () => ({ id: '55', created: true, projectId: '7' }),
    });
    expect(out.summary).toMatch(/needs-surface|Blocked/);
    expect(out.summary).toMatch(/Quality gate/);
    expect(out.quality?.needsSurfaceCount).toBe(1);
    expect(out.quality?.ok).toBe(true);
  });

  it('seeds a draft automation mapping when Squash stores a case', async () => {
    const testCases = new TestCaseService({ cases: new InMemoryTestCaseRepository(), audit: new InMemoryAuditSink() });
    const automation = new AutomationService({ automation: new InMemoryAutomationRepository(), audit: new InMemoryAuditSink() });
    const out = await publishGeneratedCases({
      workItem: '7259',
      cases,
      testCases,
      automation,
      squash: async () => ({ id: '42', created: true, projectId: '7' }),
    });
    expect(out.summary).toMatch(/Seeded 1 draft automation mapping/);
    const resolved = await automation.resolveBySquashCaseId('42');
    expect(resolved).toMatchObject({
      squashCaseId: '42',
      assetKey: 'QAP-7259-1',
      scriptPath: 'tests/app/7259.spec.js',
      status: 'draft',
      approved: false,
    });
  });
});
