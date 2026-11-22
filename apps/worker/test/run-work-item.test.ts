import { describe, expect, it } from 'vitest';
import { FakeRunnerLauncher, InMemoryAuditSink, InMemoryTestCaseRepository } from '@qa/testing';
import { isPlaceholderScreenshot, PLACEHOLDER_SCREENSHOT_B64, screenshotContentType, TestCaseService } from '@qa/application';
import { mergeLiveProgress, parseCaseResults, processWorkItemExecutions, RUNNER_REQUIRED, runWorkItemCases } from '../src/run-work-item';
import { squashIdFromSummary, syncCaseResultsToSquash } from '../src/sync-execution';

const image = `qa-runner@sha256:${'a'.repeat(64)}`;
/** Fake JPEG payload long enough to count as real evidence (not the 1×1 red stub). */
const shot = `/9j/${'A'.repeat(300)}`;

describe('screenshot evidence helpers', () => {
  it('treats the historic red 1×1 stub as a non-screenshot', () => {
    expect(isPlaceholderScreenshot(PLACEHOLDER_SCREENSHOT_B64)).toBe(true);
    expect(isPlaceholderScreenshot(shot)).toBe(false);
    expect(screenshotContentType(shot)).toBe('image/jpeg');
  });
});

describe('work-item Playwright run', () => {
  it('merges PROGRESS_JSON, RESULT_JSON, and SCREENSHOT_JSON into live case progress', () => {
    const seeded = [
      { testCaseId: 'a', name: 'Login', status: 'Queued' as const, message: 'Waiting to run', steps: [{ name: 'Open page', status: 'Queued' as const }, { name: 'Capture evidence', status: 'Queued' as const }] },
      { testCaseId: 'b', name: 'Bad', status: 'Queued' as const, message: 'Waiting to run', steps: [{ name: 'Open page', status: 'Queued' as const }] },
    ];
    const text = [
      'PROGRESS_JSON {"testCaseId":"a","name":"Login","status":"Running","message":"Opening page","steps":[{"name":"Open page","status":"Running"},{"name":"Capture evidence","status":"Queued"}]}',
      `RESULT_JSON ${JSON.stringify({ testCaseId: 'a', name: 'Login', status: 'Passed', message: 'answered 200', steps: [{ name: 'Open page', status: 'Passed' }, { name: 'Capture evidence', status: 'Passed' }] })}`,
      `SCREENSHOT_JSON ${JSON.stringify({ testCaseId: 'a', screenshotPng: shot })}`,
    ].join('\n');
    const out = mergeLiveProgress(text, seeded);
    expect(out[0]).toMatchObject({ status: 'Passed', message: 'answered 200', screenshotPng: shot });
    expect(out[0]?.steps?.[0]?.status).toBe('Passed');
    expect(out[1]?.status).toBe('Queued');
  });

  it('parses RESULT_JSON lines and attaches SCREENSHOT_JSON; drops placeholder screenshots', () => {
    const text = [
      `RESULT_JSON ${JSON.stringify({ testCaseId: 'a', name: 'Login', status: 'Passed', message: 'answered 200' })}`,
      `SCREENSHOT_JSON ${JSON.stringify({ testCaseId: 'a', screenshotPng: shot })}`,
      'noise',
      'RESULT_JSON {"testCaseId":"b","name":"Bad","status":"Failed","message":"answered 500"}',
      'SCREENSHOT_JSON {"testCaseId":"b","screenshotPng":"y"}',
    ].join('\n');
    expect(parseCaseResults(text, [])).toEqual([
      { testCaseId: 'a', name: 'Login', status: 'Passed', message: 'answered 200', screenshotPng: shot },
      { testCaseId: 'b', name: 'Bad', status: 'Failed', message: 'answered 500', screenshotPng: undefined },
    ]);
  });

  it('still accepts RESULT_JSON that inlines screenshotPng (older images)', () => {
    const text = `RESULT_JSON ${JSON.stringify({ testCaseId: 'a', name: 'Login', status: 'Passed', message: 'answered 200', screenshotPng: shot })}\n`;
    expect(parseCaseResults(text, [])[0]).toMatchObject({ testCaseId: 'a', status: 'Passed', screenshotPng: shot });
  });

  it('finds RESULT_JSON after docker noise on the same line', () => {
    const text = `\x01noise RESULT_JSON ${JSON.stringify({ testCaseId: 'a', name: 'Login', status: 'Passed', message: 'answered 200' })}\nSCREENSHOT_JSON ${JSON.stringify({ testCaseId: 'a', screenshotPng: shot })}\n`;
    expect(parseCaseResults(text, [])[0]).toMatchObject({ testCaseId: 'a', status: 'Passed', screenshotPng: shot });
  });

  it('maps legacy answered N logs to per-case Passed when RESULT_JSON is missing', () => {
    const out = parseCaseResults('answered 200\n', [{ id: 'a', name: 'Positive PayNSure' }, { id: 'b', name: 'Edge ToolKit-AgenFlow' }]);
    expect(out).toEqual([
      { testCaseId: 'a', name: 'Positive PayNSure', status: 'Passed', message: 'answered 200', steps: expect.any(Array) },
      { testCaseId: 'b', name: 'Edge ToolKit-AgenFlow', status: 'Passed', message: 'answered 200', steps: expect.any(Array) },
    ]);
  });

  it('does not treat truncated RESULT_JSON fragments as legacy answered-200', () => {
    const truncated = `RESULT_JSON {"testCaseId":"a","name":"Login","screenshotPng":"${shot.slice(0, 80)}`;
    const out = parseCaseResults(truncated, [{ id: 'a', name: 'Login' }]);
    expect(out[0]?.status).toBe('Blocked');
    expect(out[0]?.message).toMatch(/could not be parsed/);
  });

  it('explains a rebuild when the runner log has no results', () => {
    const out = parseCaseResults('chromium spawn failed\n', [{ id: 'a', name: 'Login' }]);
    expect(out[0]?.status).toBe('Blocked');
    expect(out[0]?.message).toMatch(/without case results/);
    expect(out[0]?.message).toMatch(/Rebuild qa-runner:local/);
  });

  it('keeps Blocked (no HTTP probe) when RESULT_JSON markers were truncated', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launcher.finish(handle.id, 0);
      return handle;
    };
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      workItem: '7259',
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
        logs: async () => `RESULT_JSON {"testCaseId":"33333333-3333-4333-8333-333333333333","name":"Login","screenshotPng":"${'/9j/'}${'A'.repeat(80)}\n`,
      },
      now: 1,
    });
    expect(out.viaRunner).toBe(true);
    expect(out.results[0]?.status).toBe('Blocked');
    expect(out.results[0]?.message).toMatch(/could not be parsed/);
    expect(out.results[0]?.message).not.toMatch(/^answered 200/);
  });

  it('blocks clearly when runner-launcher is missing (no HTTP probe Passed)', async () => {
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      workItem: '7259',
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
      now: 1,
    });
    expect(out.viaRunner).toBe(false);
    expect(out.results[0]?.status).toBe('Blocked');
    expect(out.results[0]?.message).toBe(RUNNER_REQUIRED);
    expect(out.results[0]?.screenshotPng).toBeUndefined();
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
        logs: async () => `RESULT_JSON ${JSON.stringify({ testCaseId: '33333333-3333-4333-8333-333333333333', name: 'Login', status: 'Passed', message: 'answered 200', screenshotPng: shot })}\n`,
      },
      now: 1,
    });
    expect(out.viaRunner).toBe(true);
    expect(out.results[0]).toMatchObject({ status: 'Passed', name: 'Login' });
    expect(launcher.specOf('runner-1').bundleRef).toBe('work-item');
    expect(launcher.specOf('runner-1').env?.QA_TARGET_URL).toBe('https://qa.shop.example/app');
    expect(launcher.specOf('runner-1').limits.pids).toBeGreaterThanOrEqual(512);
  });

  it('keeps Blocked when the runner returns no RESULT_JSON (no HTTP probe fallback)', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launcher.finish(handle.id, 0);
      return handle;
    };
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      workItem: '7259',
      environmentId: '22222222-2222-4222-8222-222222222222',
      environmentName: 'QA',
      caseCount: 1,
      status: 'running' as const,
      createdAt: new Date(),
    };
    const out = await runWorkItemCases({
      run,
      cases: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Positive PayNSure' }],
      url: 'https://qa.shop.example/app',
      launcher: {
        launcher,
        image,
        logs: async () => 'no useful output\n',
      },
      now: 1,
    });
    expect(out.viaRunner).toBe(true);
    expect(out.results[0]?.status).toBe('Blocked');
    expect(out.results[0]?.name).toBe('Positive PayNSure');
    expect(out.results[0]?.message).toMatch(/without case results/);
    expect(out.results[0]?.screenshotPng).toBeUndefined();
  });

  it('queues, claims, completes a prepared work item with per-case status', async () => {
    const repo = new InMemoryTestCaseRepository();
    const cases = new TestCaseService({ cases: repo, audit: new InMemoryAuditSink() });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Login', steps: 'Open', expected: 'Form', workItem: 'QA-1', summary: 'Squash 42' });
    const prepared = await cases.startWorkItemExecution({ id: 'eng' }, { workItem: 'QA-1', environmentId: '22222222-2222-4222-8222-222222222222', environmentName: 'QA' });
    const queued = await cases.queueWorkItemExecution({ id: 'eng' }, prepared.id);
    expect(queued.results?.[0]).toMatchObject({ status: 'Queued' });
    expect(queued.counts).toMatchObject({ queued: 1, completed: 0, total: 1 });
    const progress: string[] = [];
    const busy = await processWorkItemExecutions({
      testCases: cases,
      resolveUrl: async () => 'https://qa.shop.example',
      run: async ({ cases: listed, onProgress }) => {
        await onProgress?.(listed.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Running' as const, message: 'Opening page', steps: [{ name: 'Open', status: 'Running' as const }] })));
        progress.push('running');
        return {
          viaRunner: false,
          results: listed.map((c) => ({ testCaseId: c.id, name: c.name, status: 'Passed' as const, message: 'answered 200', screenshotPng: shot, steps: [{ name: 'Open', status: 'Passed' as const }] })),
        };
      },
      syncSquash: async (results) => ({
        results: results.map((r) => ({ ...r, squashExecutionId: '9' })),
        summary: 'Cases ran for QA-1. Squash recorded 1 execution status.',
      }),
    });
    expect(busy).toBe('busy');
    expect(progress).toEqual(['running']);
    const done = await cases.getWorkItemExecution(prepared.id);
    expect(done.status).toBe('completed');
    expect(done.results?.[0]).toMatchObject({ status: 'Passed', hasScreenshot: true, squashExecutionId: '9' });
    expect((await cases.caseScreenshot(prepared.id, done.results![0]!.testCaseId)).contentType).toBe('image/jpeg');
    expect(done.results?.[0]?.steps?.[0]).toMatchObject({ name: 'Open', status: 'Passed' });
    expect(done.counts).toMatchObject({ passed: 1, completed: 1, total: 1 });
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
      results: [{ testCaseId: 'a', name: 'Login', status: 'Passed', message: 'ok', screenshotPng: shot }],
      squashIdForCase: async () => '238',
      upsert: async () => ({ id: '77', created: true }),
      updateStatus: async () => undefined,
    });
    expect(out.results[0]?.squashExecutionId).toBe('77');
    expect(out.summary).toMatch(/Squash recorded 1/);
  });

  it('clarifies Squash token rejection with Bearer lease repair steps', async () => {
    const { PlatformError } = await import('@qa/domain');
    const out = await syncCaseResultsToSquash({
      workItem: '7259',
      results: [{ testCaseId: 'a', name: 'Positive PayNSure', status: 'Passed', message: 'ok', screenshotPng: shot }],
      squashIdForCase: async () => '238',
      upsert: async () => {
        throw new PlatformError('auth', 'SquashTM rejected the API token (expired, revoked, or not a token)');
      },
      updateStatus: async () => undefined,
    });
    expect(out.summary).toMatch(/Squash was not updated/);
    expect(out.summary).toMatch(/Bearer|READ_WRITE|restart the worker|secret lease/i);
  });
});
