import { describe, expect, it, vi } from 'vitest';
import { TestCaseService } from '@qa/application';
import { PlatformError } from '@qa/domain';
import { InMemoryAuditSink, InMemoryTestCaseRepository } from '@qa/testing';
import {
  caseOutcomesFromRegressionResults,
  performUpdateSquash,
  squashCaseIdByTestCase,
} from '../src/update-squash';

const assetId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '33333333-3333-4333-8333-333333333333';
const envId = '22222222-2222-4222-8222-222222222222';
const shot = `/9j/${'A'.repeat(300)}`;

const priorExecute = {
  results: [
    {
      testCaseId: assetId,
      name: 'Login smoke',
      status: 'Passed',
      message: 'answered 200',
      hasScreenshot: true,
      squashCaseId: '10',
    },
    {
      testCaseId: '44444444-4444-4444-8444-444444444444',
      name: 'Squash 99',
      status: 'Skipped',
      message: 'Not Automated: no Squash↔script mapping.',
      hasScreenshot: false,
      squashCaseId: '99',
    },
  ],
  evidenceExecutionId: evidenceId,
  executed: 1,
};

describe('rg.update-squash (Phase 9 E5)', () => {
  it('parses compact execute results and Squash case ids', () => {
    const outcomes = caseOutcomesFromRegressionResults(priorExecute.results);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.status).toBe('Passed');
    expect(squashCaseIdByTestCase(priorExecute.results).get(assetId)).toBe('10');
  });

  it('degrades clearly when Squash is not writable (never silent)', async () => {
    const out = await performUpdateSquash(
      {
        id: 'update_squash',
        type: 'rg.update-squash',
        runId: 'run-rg-sync-1',
        params: {},
        prior: { execute: priorExecute },
      },
      { resolveWritable: async () => undefined },
    );
    expect(out.summary).toMatch(/No writable Squash connector is switched on/i);
    const sync = out.outputs.sync as { writable: boolean; degraded: boolean; synced: number; summary: string };
    expect(sync.writable).toBe(false);
    expect(sync.degraded).toBe(true);
    expect(sync.synced).toBe(0);
  });

  it('syncs Passed statuses via upsert + updateStatus and records squashExecutionId', async () => {
    const upsert = vi.fn(async () => ({ id: '77', created: true }));
    const updateStatus = vi.fn(async () => undefined);
    const out = await performUpdateSquash(
      {
        id: 'update_squash',
        type: 'rg.update-squash',
        runId: 'run-rg-sync-2',
        params: {},
        prior: { execute: priorExecute },
      },
      {
        resolveWritable: async () => ({ upsert, updateStatus }),
      },
    );
    expect(upsert).toHaveBeenCalledWith('10');
    expect(updateStatus).toHaveBeenCalledWith('77', 'SUCCESS', 'answered 200');
    expect(out.summary).toMatch(/Squash recorded/);
    const sync = out.outputs.sync as {
      writable: boolean;
      synced: number;
      degraded: boolean;
      results: Array<{ squashExecutionId?: string; squashCaseId?: string; status: string }>;
    };
    expect(sync.writable).toBe(true);
    // Passed → SUCCESS and Skipped/Not Automated → UNTESTABLE both sync when a Squash case id is present.
    expect(sync.synced).toBe(2);
    expect(sync.degraded).toBe(false);
    expect(sync.results.find((r) => r.squashCaseId === '10')?.squashExecutionId).toBe('77');
    expect(upsert).toHaveBeenCalledWith('99');
    expect(updateStatus).toHaveBeenCalledWith('77', 'UNTESTABLE', expect.stringMatching(/Not Automated/i));
  });

  it('degrades on write failure without failing the step', async () => {
    const out = await performUpdateSquash(
      {
        id: 'update_squash',
        type: 'rg.update-squash',
        runId: 'run-rg-sync-3',
        params: {},
        prior: { execute: priorExecute },
      },
      {
        resolveWritable: async () => ({
          upsert: async () => {
            throw new PlatformError('denied', 'The Squash connector cannot change /executions (read-only)');
          },
          updateStatus: async () => undefined,
        }),
      },
    );
    expect(out.summary).toMatch(/Squash was not updated/i);
    const sync = out.outputs.sync as { degraded: boolean; writable: boolean };
    expect(sync.writable).toBe(true);
    expect(sync.degraded).toBe(true);
  });

  it('refreshes evidence squashSync and can upload screenshots from evidence', async () => {
    const cases = new TestCaseService({
      cases: new InMemoryTestCaseRepository(),
      audit: new InMemoryAuditSink(),
    });
    const opened = await cases.beginRegressionEvidenceRun({
      label: 'rg:run-rg-sync-4',
      environmentId: envId,
      environmentName: 'QA',
      cases: [
        { testCaseId: assetId, name: 'Login smoke', steps: 'Open page\nCapture evidence' },
      ],
    });
    await cases.completeWorkItemExecution(opened.id, {
      status: 'completed',
      squashSync: 'pending',
      results: [{
        testCaseId: assetId,
        name: 'Login smoke',
        status: 'Passed',
        message: 'ok',
        screenshotPng: shot,
      }],
    });

    const uploaded: string[] = [];
    const out = await performUpdateSquash(
      {
        id: 'update_squash',
        type: 'rg.update-squash',
        runId: 'run-rg-sync-4',
        params: {},
        prior: {
          execute: {
            results: [{
              testCaseId: assetId,
              name: 'Login smoke',
              status: 'Passed',
              message: 'ok',
              hasScreenshot: true,
              squashCaseId: '10',
            }],
            evidenceExecutionId: opened.id,
          },
        },
      },
      {
        testCases: cases,
        resolveWritable: async () => ({
          upsert: async () => ({ id: '88', created: true }),
          updateStatus: async () => undefined,
          uploadAttachment: async (input) => {
            uploaded.push(input.executionId);
            return { id: 'att-1' };
          },
        }),
      },
    );

    expect(uploaded).toEqual(['88']);
    expect(out.summary).toMatch(/uploaded 1 screenshot/i);
    const done = await cases.getWorkItemExecution(opened.id);
    expect(done.squashSync).toMatch(/Squash recorded/);
  });

  it('rejects non-update-squash step types', async () => {
    await expect(performUpdateSquash(
      { id: 'x', type: 'rg.execute-tests', runId: 'r', params: {}, prior: {} },
      {},
    )).rejects.toMatchObject({ errorClass: 'internal' });
  });
});
