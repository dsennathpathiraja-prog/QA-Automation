import { describe, expect, it } from 'vitest';
import {
  findEvidenceExecutionId,
  findRegressionReport,
  talliesFromCaseResults,
  workflowRunIdFromWorkItem,
} from '../src/pages/run-detail/helpers';

describe('run-detail helpers', () => {
  it('parses rg: workflow run ids', () => {
    expect(workflowRunIdFromWorkItem('rg:abc-123')).toBe('abc-123');
    expect(workflowRunIdFromWorkItem('QA-1')).toBeNull();
  });

  it('finds evidenceExecutionId from execute step outputs', () => {
    const id = findEvidenceExecutionId([
      { seq: 1, kind: 'step.completed', at: 't', payload: { stepType: 'rg.resolve-automation', outputs: {} } },
      {
        seq: 2,
        kind: 'step.completed',
        at: 't',
        payload: { stepType: 'rg.execute-tests', outputs: { evidenceExecutionId: '11111111-1111-4111-8111-111111111111' } },
      },
    ]);
    expect(id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('finds regression-report.md from step events', () => {
    const report = findRegressionReport([{
      seq: 3,
      kind: 'step.completed',
      at: 't',
      payload: {
        stepType: 'rg.regression-report',
        outputs: {
          artifactMarkdown: '# Regression report\n',
          artifactPath: 'reports/regression/x.regression-report.md',
          tallies: { passed: 2, failed: 1, blocked: 0, skipped: 0, notAutomated: 3 },
        },
      },
    }]);
    expect(report?.path).toContain('regression-report.md');
    expect(report?.tallies).toEqual({ passed: 2, failed: 1, blocked: 0, skipped: 0, notAutomated: 3 });
  });

  it('tallies Not Automated separately from other Skipped', () => {
    expect(talliesFromCaseResults([
      { status: 'Passed' },
      { status: 'Skipped', message: 'optional' },
      { status: 'Skipped', message: 'Not Automated: draft' },
      { status: 'Failed' },
    ])).toEqual({ passed: 1, failed: 1, blocked: 0, skipped: 1, notAutomated: 1 });
  });
});
