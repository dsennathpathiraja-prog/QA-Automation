import { describe, expect, it, vi } from 'vitest';
import {
  parseRegressionScopeInput,
  RegressionScopeService,
  uniqueCaseIds,
} from '@qa/application';
import {
  performConfigureScope,
  performSelectSquashProject,
  squashPortFromInvoker,
  summarizeRegressionScope,
} from '../src/configure-scope';

describe('parseRegressionScopeInput', () => {
  it('reads selected case ids and suite/campaign/collection shapes', () => {
    expect(parseRegressionScopeInput({ kind: 'selected', caseIds: ['1', '1', '2'] })).toEqual({
      kind: 'selected',
      projectId: undefined,
      caseIds: ['1', '2'],
    });
    expect(parseRegressionScopeInput({
      squashScope: { projectId: '1' },
      selection: { mode: 'all-in-suite' },
    })).toMatchObject({ kind: 'suite', projectId: '1' });
    expect(parseRegressionScopeInput({
      squashScope: '{"projectId":"9","campaignId":"10"}',
      selection: { mode: 'campaign', iterationId: '20' },
    })).toMatchObject({ kind: 'campaign', projectId: '9', campaignId: '10', iterationId: '20' });
    expect(parseRegressionScopeInput({
      selection: { mode: 'regression-collection', collectionKey: 'smoke' },
    })).toMatchObject({ kind: 'collection', collectionKey: 'smoke' });
  });
});

describe('RegressionScopeService', () => {
  it('returns ordered unique selected case ids', async () => {
    const svc = new RegressionScopeService();
    await expect(svc.resolve({ kind: 'selected', caseIds: ['a', 'b', 'a'] })).resolves.toEqual({
      caseIds: ['a', 'b'],
      kind: 'selected',
      mode: 'selected',
    });
    await expect(svc.resolve({ kind: 'selected', caseIds: [] })).rejects.toMatchObject({ errorClass: 'validation' });
  });

  it('expands suite via project list and errors when probe unavailable', async () => {
    let support: 'supported' | 'partial' | 'unsupported' = 'supported';
    const squash = {
      probeSupport: vi.fn(async () => support),
      listProjectCaseIds: vi.fn(async () => ['238', '239', '238']),
      listCampaignCaseIds: vi.fn(async () => []),
    };
    const svc = new RegressionScopeService({ squash });
    await expect(svc.resolve({ kind: 'suite', projectId: '1' })).resolves.toMatchObject({
      caseIds: ['238', '239'],
      mode: 'all-in-suite',
      projectId: '1',
    });

    support = 'unsupported';
    await expect(svc.resolve({ kind: 'suite', projectId: '1', suiteId: '99' })).rejects.toMatchObject({
      errorClass: 'unsupported',
    });
  });

  it('expands campaign via test-plan and collection via platform port', async () => {
    const squash = {
      probeSupport: vi.fn(async (cap: string) => (cap === 'tm.suite.list' ? 'unsupported' as const : 'supported' as const)),
      listProjectCaseIds: vi.fn(async () => []),
      listCampaignCaseIds: vi.fn(async () => ['238', '240']),
    };
    const collections = {
      caseIdsForCollectionKey: vi.fn(async (key: string) => (key === 'smoke' ? ['238'] : undefined)),
    };
    const svc = new RegressionScopeService({ squash, collections });
    await expect(svc.resolve({ kind: 'campaign', projectId: '1', campaignId: '10', iterationId: '20' })).resolves.toMatchObject({
      caseIds: ['238', '240'],
      mode: 'campaign',
      campaignId: '10',
      iterationId: '20',
    });
    await expect(svc.resolve({ kind: 'collection', collectionKey: 'smoke' })).resolves.toMatchObject({
      caseIds: ['238'],
      mode: 'regression-collection',
      collectionKey: 'smoke',
    });
    await expect(svc.resolve({ kind: 'collection', collectionKey: 'missing' })).rejects.toMatchObject({ errorClass: 'not-found' });
  });
});

describe('rg.configure-scope / select-squash-project', () => {
  it('selects project and configures selected scope for resolve', async () => {
    const select = await performSelectSquashProject({
      id: 'select_project',
      type: 'rg.select-squash-project',
      runId: 'r1',
      params: { squashScope: { projectId: '1' }, selection: { mode: 'selected', caseIds: ['238', '239'] } },
      prior: {},
    });
    expect(select.outputs.projectId).toBe('1');

    const configured = await performConfigureScope({
      id: 'configure_scope',
      type: 'rg.configure-scope',
      runId: 'r1',
      params: { selection: { mode: 'selected', caseIds: ['238', '239'] } },
      prior: { select_project: { projectId: '1' } },
    }, {});
    expect(configured.outputs.scope).toMatchObject({ caseIds: ['238', '239'], mode: 'selected' });
    expect(summarizeRegressionScope(configured.outputs.scope as never)).toMatch(/2 Squash case ids/);
  });

  it('uses squash invoker for campaign case ids', async () => {
    const invoke = vi.fn(async (capability: string, input: Record<string, unknown>) => {
      if (capability === 'tm.capabilities.probe') {
        return {
          capabilities: [
            { capability: 'tm.campaign.list', support: 'supported' },
            { capability: 'tm.iteration.testplan.list', support: 'supported' },
          ],
        };
      }
      if (capability === 'tm.iteration.list') {
        return { items: [{ id: '20', name: 'Iteration 1' }] };
      }
      if (capability === 'tm.iteration.testplan.list') {
        expect(input.iteration).toBe('20');
        return { items: [{ id: '1001', testCaseId: '238' }, { id: '1002', testCaseId: '239' }] };
      }
      return { items: [] };
    });
    const configured = await performConfigureScope({
      id: 'configure_scope',
      type: 'rg.configure-scope',
      runId: 'r1',
      params: {
        squashScope: { projectId: '1', campaignId: '10' },
        selection: { mode: 'campaign' },
      },
      prior: { select_project: { projectId: '1' } },
    }, { squash: squashPortFromInvoker(invoke) });
    expect(uniqueCaseIds((configured.outputs.scope as { caseIds: string[] }).caseIds)).toEqual(['238', '239']);
  });
});
