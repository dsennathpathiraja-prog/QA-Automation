import { describe, expect, it } from 'vitest';
import { FakeRunnerLauncher, InMemoryAuditSink, InMemoryTestCaseRepository, sampleRunnerSpec } from '@qa/testing';
import { isPlaceholderScreenshot, PLACEHOLDER_SCREENSHOT_B64, screenshotContentType, TestCaseService } from '@qa/application';
import { PlatformError } from '@qa/domain';
import { compactCasesForRunner, launchWhenPoolFree, mergeLiveProgress, parseCaseResults, processWorkItemExecutions, RUNNER_REQUIRED, runWorkItemCases } from '../src/run-work-item';
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
    expect(out[0]?.message).toMatch(/Rebuild qa-runner:local|PowerShell|docker compose -f deploy\/compose\/local/);
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
    expect(launcher.specOf('runner-1').env?.QA_CASES_JSON).toBeUndefined();
    expect(launcher.specOf('runner-1').env?.QA_CASES_FILE).toBeUndefined();
    expect(launcher.specOf('runner-1').inlineFiles).toBeUndefined();
    expect(launcher.specOf('runner-1').env?.QA_CASES_PARTS).toBe('1');
    expect(JSON.parse(launcher.specOf('runner-1').env!.QA_CASES_P0!)).toEqual([
      { id: '33333333-3333-4333-8333-333333333333', name: 'Login', steps: ['Open page', 'Capture evidence'] },
    ]);
    expect(launcher.specOf('runner-1').limits.pids).toBeGreaterThanOrEqual(512);
  });

  it('packs hundreds of cases into chunked env vars under the 4096-byte cap', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launcher.finish(handle.id, 0);
      return handle;
    };
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
      name: `Case ${i}: ${'x'.repeat(80)}`,
      steps: Array.from({ length: 20 }, (_, j) => `import { test } from '@playwright/test'; // line ${j} ${'y'.repeat(40)}`).join('\n'),
    }));
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      workItem: '5289',
      environmentId: '22222222-2222-4222-8222-222222222222',
      environmentName: 'PayNSure',
      caseCount: many.length,
      status: 'running' as const,
      createdAt: new Date(),
    };
    const firstId = many[0]!.id;
    const out = await runWorkItemCases({
      run,
      cases: many,
      url: 'https://qa.shop.example/app',
      launcher: {
        launcher,
        image,
        logs: async () => many.map((c) => `RESULT_JSON ${JSON.stringify({ testCaseId: c.id, name: c.name, status: 'Passed', message: 'answered 200' })}`).join('\n'),
      },
      now: 1,
    });
    const spec = launcher.specOf('runner-1');
    expect(spec.env?.QA_CASES_JSON).toBeUndefined();
    expect(spec.inlineFiles).toBeUndefined();
    const parts = Number(spec.env?.QA_CASES_PARTS);
    expect(parts).toBeGreaterThan(1);
    let raw = '';
    for (let i = 0; i < parts; i += 1) {
      const piece = spec.env?.[`QA_CASES_P${i}`];
      expect(piece!.length).toBeLessThanOrEqual(4000);
      raw += piece;
    }
    expect(JSON.parse(raw)).toHaveLength(200);
    expect(compactCasesForRunner(many)[0]?.steps).toEqual(['Open page', 'Capture evidence']);
    expect(out.results).toHaveLength(200);
    expect(out.results[0]).toMatchObject({ testCaseId: firstId, status: 'Passed' });
    expect(spec.limits.timeoutSeconds).toBeGreaterThanOrEqual(90 + 200 * 25);
  });

  it('waits and retries when the runner pool is temporarily full', async () => {
    const launcher = new FakeRunnerLauncher();
    let calls = 0;
    const realLaunch = launcher.launch.bind(launcher);
    launcher.launch = async (spec, opts) => {
      calls += 1;
      if (calls < 3) throw new PlatformError('transient', 'the runner pool is full (2/2 active); try again later');
      return realLaunch(spec, opts);
    };
    let now = 0;
    const handle = await launchWhenPoolFree(launcher, sampleRunnerSpec({ image }), {
      waitMs: 60_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(handle.id).toBeTruthy();
    expect(calls).toBe(3);
  });

  it('fails clearly after waiting if the runner pool stays full', async () => {
    const launcher = new FakeRunnerLauncher();
    launcher.launch = async () => {
      throw new PlatformError('transient', 'the runner pool is full (8/8 active); try again later');
    };
    let now = 0;
    await expect(launchWhenPoolFree(launcher, sampleRunnerSpec({ image }), {
      waitMs: 1_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    })).rejects.toThrow(/pool stayed full|PowerShell|ForEach-Object/);
  });

  it('stops the runner and marks cases Skipped when the operator cancels mid-run', async () => {
    const launcher = new FakeRunnerLauncher();
    const realLaunch = launcher.launch.bind(launcher);
    let launched = '';
    launcher.launch = async (spec, opts) => {
      const handle = await realLaunch(spec, opts);
      launched = handle.id;
      return handle;
    };
    const run = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workItem: '2357',
      environmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      environmentName: 'QA',
      caseCount: 2,
      status: 'running' as const,
      createdAt: new Date(),
    };
    const cases = [
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Case A' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Case B' },
    ];
    let polls = 0;
    await expect(runWorkItemCases({
      run,
      cases,
      url: 'https://qa.shop.example/app',
      launcher: { launcher, image, logs: async () => '' },
      now: 1,
      isCancelled: () => {
        polls += 1;
        return polls > 2;
      },
    })).rejects.toMatchObject({ errorClass: 'cancelled' });
    expect(launched).toBeTruthy();
    expect((await launcher.status(launched)).state).toBe('stopped');
    expect((await launcher.cancelByExecution(run.id)).stopped).toBe(0);
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

  it('cancelWorkItemExecution marks queued runs cancelled without claiming', async () => {
    const repo = new InMemoryTestCaseRepository();
    const cases = new TestCaseService({ cases: repo, audit: new InMemoryAuditSink() });
    await cases.fileUnderWorkItem({ id: 'worker' }, { name: 'Login', steps: 'Open', expected: 'Form', workItem: 'QA-9', summary: 'Squash 1' });
    const prepared = await cases.startWorkItemExecution({ id: 'eng' }, { workItem: 'QA-9', environmentId: '22222222-2222-4222-8222-222222222222', environmentName: 'QA' });
    await cases.queueWorkItemExecution({ id: 'eng' }, prepared.id);
    const cancelled = await cases.cancelWorkItemExecution({ id: 'eng' }, prepared.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.results?.[0]?.status).toBe('Skipped');
    expect(await processWorkItemExecutions({
      testCases: cases,
      resolveUrl: async () => 'https://qa.shop.example',
      run: async () => ({ viaRunner: false, results: [] }),
    })).toBe('idle');
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
