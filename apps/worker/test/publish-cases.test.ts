import { describe, expect, it } from 'vitest';
import { TestCaseService } from '@qa/application';
import { InMemoryAuditSink, InMemoryTestCaseRepository } from '@qa/testing';
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
});
