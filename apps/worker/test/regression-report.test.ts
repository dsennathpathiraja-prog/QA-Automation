import { describe, expect, it } from 'vitest';
import {
  compareRuns,
  performRegressionReport,
  regressionReportArtifactPath,
  renderRegressionReportMarkdown,
  talliesFromResults,
} from '../src/regression-report';

const assetId = '11111111-1111-4111-8111-111111111111';
const evidenceId = '33333333-3333-4333-8333-333333333333';

const results = [
  {
    testCaseId: assetId,
    name: 'Login smoke',
    status: 'Passed',
    message: 'answered 200',
    hasScreenshot: true,
    squashCaseId: '10',
    squashExecutionId: '77',
  },
  {
    testCaseId: '44444444-4444-4444-8444-444444444444',
    name: 'Squash 99',
    status: 'Skipped',
    message: 'Not Automated: no Squash↔script mapping.',
    hasScreenshot: false,
    squashCaseId: '99',
  },
  {
    testCaseId: '55555555-5555-4555-8555-555555555555',
    name: 'Checkout',
    status: 'Failed',
    message: 'timeout',
    hasScreenshot: true,
    squashCaseId: '11',
  },
];

describe('rg.regression-report (Phase 9 E5)', () => {
  it('builds a stable artifact path', () => {
    expect(regressionReportArtifactPath('Run ABC 1')).toBe('reports/regression/run-abc-1.regression-report.md');
  });

  it('tallies Passed/Failed/Blocked/Skipped/Not Automated', () => {
    expect(talliesFromResults([
      { testCaseId: 'a', name: 'a', status: 'Passed', message: 'ok' },
      { testCaseId: 'b', name: 'b', status: 'Failed', message: 'x' },
      { testCaseId: 'c', name: 'c', status: 'Blocked', message: 'y' },
      { testCaseId: 'd', name: 'd', status: 'Skipped', message: 'optional' },
      { testCaseId: 'e', name: 'e', status: 'Skipped', message: 'Not Automated: draft', notAutomated: true },
    ])).toEqual({ passed: 1, failed: 1, blocked: 1, skipped: 1, notAutomated: 1 });
  });

  it('renders deterministic markdown with evidence links and sync line', () => {
    const md = renderRegressionReportMarkdown({
      runId: 'run-1',
      environmentName: 'QA',
      applicationUrl: 'https://qa.shop.example/app',
      evidenceExecutionId: evidenceId,
      syncSummary: 'Cases ran for rg:run-1. Squash recorded 1 execution status.',
      syncWritable: true,
      syncDegraded: false,
      results: [
        {
          testCaseId: assetId,
          name: 'Login smoke',
          status: 'Passed',
          message: 'answered 200',
          hasScreenshot: true,
          squashCaseId: '10',
          notAutomated: false,
        },
        {
          testCaseId: 'x',
          name: 'Squash 99',
          status: 'Skipped',
          message: 'Not Automated: no Squash↔script mapping.',
          squashCaseId: '99',
          notAutomated: true,
        },
      ],
    });
    expect(md).toContain('# Regression report: run-1');
    expect(md).toContain('**Passed:** 1');
    expect(md).toContain('**Not Automated:** 1');
    expect(md).toContain('Squash recorded 1');
    expect(md).toContain(`[screenshot](/runs/${evidenceId}?view=evidence&case=${assetId}&from=evidence)`);
    expect(md).toContain('| Login smoke | 10 | Passed |');
    expect(md).toContain('| Squash 99 | 99 | Not Automated |');
    expect(md).not.toContain('Compare to previous run');
  });

  it('compares status deltas versus a previous run', () => {
    const deltas = compareRuns(
      [
        { testCaseId: assetId, name: 'Login smoke', status: 'Failed', message: 'x', squashCaseId: '10' },
        { testCaseId: 'y', name: 'Other', status: 'Passed', message: 'ok', squashCaseId: '11' },
      ],
      [
        { testCaseId: assetId, name: 'Login smoke', status: 'Passed', message: 'ok', squashCaseId: '10' },
        { testCaseId: 'y', name: 'Other', status: 'Passed', message: 'ok', squashCaseId: '11' },
      ],
    );
    expect(deltas).toEqual([{ name: 'Login smoke', squashCaseId: '10', from: 'Passed', to: 'Failed' }]);
  });

  it('writes artifactMarkdown/artifactPath and optional compare outputs', async () => {
    const out = await performRegressionReport(
      {
        id: 'report',
        type: 'rg.regression-report',
        runId: 'run-rg-report-1',
        params: {},
        prior: {
          execute: {
            results,
            evidenceExecutionId: evidenceId,
            environment: { id: 'env-1', name: 'QA', applicationUrl: 'https://qa.shop.example/app' },
          },
          update_squash: {
            sync: {
              summary: 'Cases ran for rg:run-rg-report-1. No writable Squash connector is switched on.',
              writable: false,
              synced: 0,
              degraded: true,
            },
          },
        },
      },
      {
        findPreviousRun: async () => ({
          id: 'prev-1',
          workItem: 'rg:previous',
          finishedAt: '2026-11-20T12:00:00.000Z',
          environmentId: 'env-1',
          results: [
            {
              testCaseId: assetId,
              name: 'Login smoke',
              status: 'Failed',
              message: 'old',
              squashCaseId: '10',
            },
            {
              testCaseId: '44444444-4444-4444-8444-444444444444',
              name: 'Squash 99',
              status: 'Skipped',
              message: 'Not Automated: no Squash↔script mapping.',
              squashCaseId: '99',
              notAutomated: true,
            },
            {
              testCaseId: '55555555-5555-4555-8555-555555555555',
              name: 'Checkout',
              status: 'Failed',
              message: 'timeout',
              squashCaseId: '11',
            },
          ],
        }),
      },
    );

    expect(out.summary).toMatch(/1 status change/i);
    expect(out.outputs.artifactPath).toBe('reports/regression/run-rg-report-1.regression-report.md');
    expect(String(out.outputs.artifactMarkdown)).toContain('Compare to previous run');
    expect(String(out.outputs.artifactMarkdown)).toContain('_(degraded)_');
    expect(out.outputs.tallies).toEqual({
      passed: 1,
      failed: 1,
      blocked: 0,
      skipped: 0,
      notAutomated: 1,
    });
    expect(out.outputs.compare).toMatchObject({
      previousRunId: 'prev-1',
      previousWorkItem: 'rg:previous',
      deltaCount: 1,
      deltas: [{ name: 'Login smoke', squashCaseId: '10', from: 'Failed', to: 'Passed' }],
    });
  });

  it('omits compare when no previous run exists', async () => {
    const out = await performRegressionReport(
      {
        id: 'report',
        type: 'rg.regression-report',
        runId: 'run-rg-report-2',
        params: { results },
        prior: {},
      },
      { findPreviousRun: async () => undefined },
    );
    expect(out.summary).toMatch(/Regression report written/);
    expect(out.summary).not.toMatch(/compared/i);
    expect(out.outputs.compare).toBeUndefined();
    expect(String(out.outputs.artifactMarkdown)).not.toContain('Compare to previous run');
  });
});
