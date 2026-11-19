import { describe, expect, it } from 'vitest';
import { TestCaseService } from '@qa/application';
import { InMemoryAuditSink, InMemoryTestCaseRepository } from '@qa/testing';
import { publishGeneratedCases } from '../src/publish-cases';

const cases = [{ name: 'Positive', steps: 'Open', expected: 'Ok', workItem: '7259', reference: 'QAP-7259-1' }];

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
});
