import { describe, expect, it, vi } from 'vitest';
import { AutomationService, TestCaseService } from '@qa/application';
import { InMemoryAuditSink, InMemoryAutomationRepository, InMemoryTestCaseRepository } from '@qa/testing';
import {
  approvedCaseInput,
  notAutomatedOutcome,
  performExecuteTests,
  regressionAutomationFromStep,
  summarizeExecuteResults,
} from '../src/execute-tests';
import { performSelectEnvironment } from '../src/select-environment';

const assetId = '11111111-1111-4111-8111-111111111111';
const envId = '22222222-2222-4222-8222-222222222222';

describe('rg.execute-tests (Phase 9 E2)', () => {
  it('reads approved resolve outputs and drops draft rows from the execute set', () => {
    const out = regressionAutomationFromStep({
      params: {},
      prior: {
        resolve_automation: {
          resolved: [
            { squashCaseId: '10', squashReference: 'TC-10', assetId, assetKey: 'ok', assetName: 'Ok', scriptPath: 'tests/ok.spec.js', status: 'approved' },
            { squashCaseId: '11', assetId: 'draft-id', assetName: 'Draft', scriptPath: 'x', status: 'draft' },
          ],
          notAutomated: [
            { squashCaseId: '99', reason: 'no-mapping' },
          ],
        },
      },
    });
    expect(out.resolved).toHaveLength(1);
    expect(out.resolved[0]?.squashCaseId).toBe('10');
    expect(out.notAutomated.map((r) => r.squashCaseId).sort()).toEqual(['11', '99']);
    expect(out.notAutomated.find((r) => r.squashCaseId === '11')?.reason).toBe('mapping-unapproved');
  });

  it('maps Not Automated to Skipped without launching', () => {
    const row = notAutomatedOutcome({ squashCaseId: '99', reason: 'no-mapping' });
    expect(row.status).toBe('Skipped');
    expect(row.message).toMatch(/no Squash↔script mapping/i);
  });

  it('builds runner cases from approved assets (asset id as testCaseId)', () => {
    expect(approvedCaseInput({
      squashCaseId: '10',
      squashReference: 'TC-10',
      assetId,
      assetKey: 'ok',
      assetName: 'Login smoke',
      scriptPath: 'tests/ok.spec.js',
      status: 'approved',
    })).toMatchObject({ id: assetId, name: 'Login smoke' });
  });

  it('executes only approved assets via runCases and skips Not Automated', async () => {
    const runCases = vi.fn(async ({ cases }) => ({
      viaRunner: true,
      results: cases.map((c: { id: string; name: string }) => ({
        testCaseId: c.id,
        name: c.name,
        status: 'Passed' as const,
        message: 'answered 200',
        screenshotPng: `/9j/${'A'.repeat(300)}`,
        steps: [
          { name: 'Open page', status: 'Passed' as const },
          { name: 'Capture evidence', status: 'Passed' as const },
        ],
      })),
    }));

    const out = await performExecuteTests(
      {
        id: 'execute',
        type: 'rg.execute-tests',
        runId: 'run-rg-1',
        params: { applicationUrl: 'https://qa.shop.example/app' },
        prior: {
          resolve_automation: {
            resolved: [{
              squashCaseId: '10',
              squashReference: 'TC-10',
              assetId,
              assetKey: 'ok',
              assetName: 'Ok',
              scriptPath: 'tests/ok.spec.js',
              status: 'approved',
            }],
            notAutomated: [
              { squashCaseId: '11', reason: 'mapping-unapproved', status: 'draft' },
              { squashCaseId: '99', reason: 'no-mapping' },
            ],
          },
        },
      },
      { runCases },
    );

    expect(runCases).toHaveBeenCalledTimes(1);
    expect(runCases.mock.calls[0]?.[0].cases).toEqual([
      expect.objectContaining({ id: assetId, name: 'Ok' }),
    ]);
    expect(out.summary).toMatch(/via Playwright runner/);
    expect(out.summary).toMatch(/Not Automated skipped/);
    expect(out.outputs.viaRunner).toBe(true);
    expect(out.outputs.executed).toBe(1);
    const results = out.outputs.results as Array<{ status: string; hasScreenshot?: boolean; squashCaseId?: string }>;
    expect(results.filter((r) => r.status === 'Passed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'Skipped')).toHaveLength(2);
    expect(results.find((r) => r.status === 'Passed')?.hasScreenshot).toBe(true);
    expect(results.find((r) => r.status === 'Passed')?.squashCaseId).toBe('10');
  });

  it('persists live evidence on a work-item execution row', async () => {
    const testCases = new TestCaseService({
      cases: new InMemoryTestCaseRepository(),
      audit: new InMemoryAuditSink(),
    });
    const progress: unknown[] = [];
    const out = await performExecuteTests(
      {
        id: 'execute',
        type: 'rg.execute-tests',
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        params: {
          environment: { id: envId, name: 'QA', applicationUrl: 'https://qa.shop.example/' },
        },
        prior: {
          resolve_automation: {
            resolved: [{
              squashCaseId: '10',
              squashReference: 'TC-10',
              assetId,
              assetKey: 'ok',
              assetName: 'Ok',
              scriptPath: 'tests/ok.spec.js',
              status: 'approved',
            }],
            notAutomated: [],
          },
        },
      },
      {
        testCases,
        runCases: async ({ cases, onProgress }) => {
          const running = cases.map((c) => ({
            testCaseId: c.id,
            name: c.name,
            status: 'Running' as const,
            message: 'Opening page',
          }));
          await onProgress?.(running);
          progress.push(running);
          const done = cases.map((c) => ({
            testCaseId: c.id,
            name: c.name,
            status: 'Passed' as const,
            message: 'answered 200',
            screenshotPng: `/9j/${'A'.repeat(300)}`,
          }));
          await onProgress?.(done);
          return { viaRunner: true, results: done };
        },
      },
    );

    const evidenceId = out.outputs.evidenceExecutionId as string;
    expect(evidenceId).toMatch(/^[0-9a-f-]{36}$/i);
    const board = await testCases.getWorkItemExecution(evidenceId);
    expect(board.status).toBe('completed');
    expect(board.results?.[0]).toMatchObject({ status: 'Passed', hasScreenshot: true });
    expect(progress.length).toBeGreaterThan(0);
  });

  it('does not call the runner when only Not Automated cases are in scope', async () => {
    const runCases = vi.fn();
    const out = await performExecuteTests(
      {
        id: 'execute',
        type: 'rg.execute-tests',
        runId: 'run-empty',
        params: { applicationUrl: 'https://qa.shop.example/' },
        prior: {
          resolve_automation: {
            resolved: [],
            notAutomated: [{ squashCaseId: '99', reason: 'no-mapping' }],
          },
        },
      },
      { runCases },
    );
    expect(runCases).not.toHaveBeenCalled();
    expect(out.outputs.executed).toBe(0);
    expect(out.outputs.viaRunner).toBe(false);
  });

  it('refuses execute without an environment URL', async () => {
    await expect(performExecuteTests(
      {
        id: 'execute',
        type: 'rg.execute-tests',
        runId: 'run-no-env',
        params: {},
        prior: {
          resolve_automation: {
            resolved: [{
              squashCaseId: '10',
              squashReference: 'TC-10',
              assetId,
              assetKey: 'ok',
              assetName: 'Ok',
              scriptPath: 'tests/ok.spec.js',
              status: 'approved',
            }],
            notAutomated: [],
          },
        },
      },
      { runCases: async () => ({ viaRunner: false, results: [] }) },
    )).rejects.toMatchObject({ errorClass: 'validation' });
  });

  it('summarizes empty execute scope', () => {
    expect(summarizeExecuteResults({ executed: 0, notAutomated: 0, viaRunner: false, results: [] }))
      .toMatch(/No approved automation/);
  });
});

describe('rg.select-environment (Phase 9 E2 helper)', () => {
  it('resolves a direct application URL for execute', async () => {
    const out = await performSelectEnvironment(
      {
        id: 'select_env',
        type: 'rg.select-environment',
        runId: 'r',
        params: { applicationUrl: 'https://qa.shop.example/app', environmentName: 'QA' },
        prior: {},
      },
      undefined,
    );
    expect(out.outputs.resolved).toMatchObject({
      name: 'QA',
      applicationUrl: 'https://qa.shop.example/app',
    });
  });

  it('looks up environment id via repository', async () => {
    const out = await performSelectEnvironment(
      {
        id: 'select_env',
        type: 'rg.select-environment',
        runId: 'r',
        params: { environment: envId },
        prior: {},
      },
      async (id) => (id === envId ? { id: envId, name: 'QA', applicationUrl: 'https://qa.shop.example/' } : undefined),
    );
    expect(out.summary).toMatch(/Selected environment QA/);
    expect(out.outputs.resolved).toMatchObject({ id: envId, applicationUrl: 'https://qa.shop.example/' });
  });
});

describe('resolve → execute wiring', () => {
  it('approved mapping from AutomationService feeds execute without generation', async () => {
    const automation = new AutomationService({
      automation: new InMemoryAutomationRepository(),
      audit: new InMemoryAuditSink(),
    });
    const actor = { id: 'lead' };
    const ok = await automation.register(actor, {
      key: 'QAP-ok',
      name: 'Ok',
      scriptPath: 'tests/ok.spec.js',
      squashCaseId: '10',
    });
    await automation.approve(actor, ok.id);
    await automation.register(actor, {
      key: 'QAP-draft',
      name: 'Draft',
      scriptPath: 'tests/draft.spec.js',
      squashCaseId: '11',
    });
    const resolved = await automation.resolveForRegression(['10', '11']);
    const runCases = vi.fn(async ({ cases }) => ({
      viaRunner: true,
      results: cases.map((c: { id: string; name: string }) => ({
        testCaseId: c.id,
        name: c.name,
        status: 'Passed' as const,
        message: 'answered 200',
      })),
    }));
    const out = await performExecuteTests(
      {
        id: 'execute',
        type: 'rg.execute-tests',
        runId: 'run-wired',
        params: { applicationUrl: 'https://qa.shop.example/' },
        prior: { resolve_automation: { ...resolved } },
      },
      { runCases },
    );
    expect(runCases.mock.calls[0]?.[0].cases).toHaveLength(1);
    expect(out.outputs.executed).toBe(1);
    expect((out.outputs.notAutomated as unknown[]).length).toBe(1);
  });
});
