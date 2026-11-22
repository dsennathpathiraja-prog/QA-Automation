import { describe, expect, it } from 'vitest';
import { AutomationService } from '@qa/application';
import { InMemoryAuditSink, InMemoryAutomationRepository } from '@qa/testing';
import {
  performResolveAutomation,
  squashCaseIdsForResolve,
  summarizeRegressionResolve,
} from '../src/resolve-automation';

describe('rg.resolve-automation (Phase 9 E1)', () => {
  it('reads Squash case ids from params or configure_scope outputs', () => {
    expect(squashCaseIdsForResolve({
      params: { squashCaseIds: ['1', '2', '1'] },
      prior: {},
    })).toEqual(['1', '2']);
    expect(squashCaseIdsForResolve({
      params: {},
      prior: { configure_scope: { scope: { caseIds: ['9', '8'] } } },
    })).toEqual(['9', '8']);
    expect(squashCaseIdsForResolve({ params: {}, prior: {} })).toEqual([]);
  });

  it('resolves approved mappings and lists Not Automated without generating', async () => {
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

    const out = await performResolveAutomation(
      {
        id: 'resolve_automation',
        type: 'rg.resolve-automation',
        runId: 'run-1',
        params: { squashCaseIds: ['10', '11', '99'] },
        prior: {},
      },
      automation,
    );

    expect(out.summary).toMatch(/Resolved 1 approved/);
    expect(out.summary).toMatch(/Not Automated: 2/);
    expect(out.summary).toMatch(/No generation or explore/);
    expect(out.outputs.resolved).toEqual([
      expect.objectContaining({ squashCaseId: '10', assetId: ok.id, status: 'approved' }),
    ]);
    expect(out.outputs.notAutomated).toEqual([
      expect.objectContaining({ squashCaseId: '11', reason: 'mapping-unapproved' }),
      expect.objectContaining({ squashCaseId: '99', reason: 'no-mapping' }),
    ]);
  });

  it('summarizes an empty scope without failing', () => {
    expect(summarizeRegressionResolve({ resolved: [], notAutomated: [] })).toMatch(/No Squash case ids/);
  });

  it('refuses when the automation service is not wired', async () => {
    await expect(performResolveAutomation(
      { id: 'resolve_automation', type: 'rg.resolve-automation', runId: 'r', params: { squashCaseIds: ['1'] }, prior: {} },
      undefined,
    )).rejects.toMatchObject({ errorClass: 'denied' });
  });
});
