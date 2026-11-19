import { describe, expect, it } from 'vitest';
import { FakeRunnerLauncher, InMemoryAuditSink, InMemoryTestCaseRepository } from '@qa/testing';
import { TestCaseService } from '@qa/application';
import { parseCaseResults, processWorkItemExecutions, runWorkItemCases } from '../src/run-work-item';
import { squashIdFromSummary, syncCaseResultsToSquash } from '../src/sync-execution';

const image = `qa-runner@sha256:${'a'.repeat(64)}`;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('work-item Playwright run', () => {
  it('parses RESULT_JSON lines from the runner', () => {
    const text = [
      'RESULT_JSON {"testCaseId":"a","name":"Login","status":"Passed","message":"answered 200","screenshotPng":"x"}',
      'noise',
      'RESULT_JSON {"testCaseId":"b","name":"Bad","status":"Failed","message":"answered 500","screenshotPng":"y"}',
    ].join('\n');
    expect(parseCaseResults(text, [])).toEqual([
      { testCaseId: 'a', name: 'Login', status: 'Passed', message: 'answered 200', screenshotPng: 'x' },
      { testCaseId: 'b', name: 'Bad', status: 'Failed', message: 'answered 500', screenshotPng: 'y' },
    ]);
  });

  it('runs through the launcher with bundleRef work-item', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launcher.finish(handle.id, 0);
      return handle;
    };
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      workItem: 'QA-1',
      environmentId: '22222222-2222-4222-8222-222222222222',
      environmentName: 'QA',
      caseCount: 1,
      status: 'running' as const,
      createdAt: new Date(),
    };
    const out = await runWorkItemCases({
      run,
      cases: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Login' }],
      url: 'https://qa.shop.example/app',
      launcher: {
        launcher,
        image,
        logs: async () => `RESULT_JSON ${JSON.stringify({ testCaseId: '33333333-3333-4333-8333-333333333333', name: 'Login', status: 'Passed', message: 'answered 200', screenshotPng: png })}\n`,
      },
      now: 1,
    });
    expect(out.viaRunner).toBe(true);
    expect(out.results[0]).toMatchObject({ status: 'Passed', name: 'Login' });
    expect(launcher.specOf('runner-1').bundleRef).toBe('work-item');
    expect(launcher.specOf('runner-1').env?.QA_TARGET_URL).toBe('https://qa.shop.example/app');
  });

  it('queues, claims, completes a prepared work item with per-case status', async () => {
    const repo = new InMemoryTestCaseRepository();
    const cases = new TestCaseService({ cases: repo, audit: new InMemoryAuditSink() });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Login', steps: 'Open', expected: 'Form', workItem: 'QA-1', summary: 'Squash 42' });
    const prepared = await cases.startWorkItemExecution({ id: 'eng' }, { workItem: 'QA-1', environmentId: '22222222-2222-4222-8222-222222222222', environmentName: 'QA' });
    await cases.queueWorkItemExecution({ id: 'eng' }, prepared.id);
    const busy = await processWorkItemExecutions({
      testCases: cases,
      resolveUrl: async () => 'https://qa.shop.example',
      run: async ({ cases: listed }) => ({
        viaRunner: false,
        results: listed.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Passed' as const, message: 'answered 200', screenshotPng: png })),
      }),
      syncSquash: async (results) => ({
        results: results.map((r) => ({ ...r, squashExecutionId: '9' })),
        summary: 'Cases ran for QA-1. Squash recorded 1 execution status.',
      }),
    });
    expect(busy).toBe('busy');
    const done = await cases.getWorkItemExecution(prepared.id);
    expect(done.status).toBe('completed');
    expect(done.results?.[0]).toMatchObject({ status: 'Passed', hasScreenshot: true, squashExecutionId: '9' });
    expect(done.squashSync).toMatch(/Squash recorded/);
  });
});

describe('Squash execution sync', () => {
  it('reads Squash ids from the Test Cases summary', () => {
    expect(squashIdFromSummary('Squash 42')).toBe('42');
    expect(squashIdFromSummary('QAP-1')).toBeUndefined();
  });

  it('maps Passed to SUCCESS and stores the Squash execution id', async () => {
    const out = await syncCaseResultsToSquash({
      workItem: 'QA-1',
      results: [{ testCaseId: 'a', name: 'Login', status: 'Passed', message: 'ok', screenshotPng: png }],
      squashIdForCase: async () => '238',
      upsert: async () => ({ id: '77', created: true }),
      updateStatus: async () => undefined,
    });
    expect(out.results[0]?.squashExecutionId).toBe('77');
    expect(out.summary).toMatch(/Squash recorded 1/);
  });
});
