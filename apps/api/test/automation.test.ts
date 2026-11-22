import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AutomationService } from '@qa/application';
import { InMemoryAuditSink, InMemoryAutomationRepository } from '@qa/testing';
import { buildApp, DevHeaderSessionResolver } from '../src';

const lead = { 'x-dev-user': 'lead', 'x-dev-groups': 'QA-Platform-Leads' };
const engineer = { 'x-dev-user': 'eng', 'x-dev-groups': 'QA-Platform-Engineers' };
let app: FastifyInstance;
let automation: AutomationService;
const spies: { mockRestore(): void }[] = [];

beforeEach(async () => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  automation = new AutomationService({ automation: new InMemoryAutomationRepository(), audit: new InMemoryAuditSink() });
  app = buildApp({
    sessions: new DevHeaderSessionResolver('test'),
    profile: 'standard',
    automation,
  });
});
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

describe('automation resolve (Phase 9 E1)', () => {
  it('single resolve still returns draft; regression prep is approved-only', async () => {
    const draft = await automation.register({ id: 'eng' }, {
      key: 'QAP-a',
      name: 'A',
      scriptPath: 'tests/a.spec.js',
      squashCaseId: '238',
    });
    const sibling = await automation.register({ id: 'eng' }, {
      key: 'QAP-b',
      name: 'B',
      scriptPath: 'tests/b.spec.js',
      squashCaseId: '239',
    });
    await automation.approve({ id: 'lead' }, draft.id);

    const one = await app.inject({
      method: 'GET',
      url: '/api/v1/automation/resolve?squashCaseId=238',
      headers: engineer,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ squashCaseId: '238', approved: true, status: 'approved', assetId: draft.id });

    const draftOne = await app.inject({
      method: 'GET',
      url: '/api/v1/automation/resolve?squashCaseId=239',
      headers: engineer,
    });
    expect(draftOne.json()).toMatchObject({ squashCaseId: '239', approved: false, status: 'draft', assetId: sibling.id });

    const prep = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/resolve-regression',
      headers: lead,
      payload: { squashCaseIds: ['238', '239', '999'] },
    });
    expect(prep.statusCode).toBe(200);
    expect(prep.json()).toEqual({
      resolved: [
        expect.objectContaining({ squashCaseId: '238', assetId: draft.id, status: 'approved' }),
      ],
      notAutomated: [
        expect.objectContaining({ squashCaseId: '239', reason: 'mapping-unapproved', status: 'draft' }),
        expect.objectContaining({ squashCaseId: '999', reason: 'no-mapping' }),
      ],
    });
  });

  it('rejects an empty regression resolve body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/resolve-regression',
      headers: engineer,
      payload: { squashCaseIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('automation scope (Phase 9 E3)', () => {
  it('expands selected case ids for Regression prep', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/scope',
      headers: engineer,
      payload: { kind: 'selected', caseIds: ['238', '238', '239'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      caseIds: ['238', '239'],
      kind: 'selected',
      mode: 'selected',
    });
  });

  it('expands collection when caseIds override is supplied (E4 stub path)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/scope',
      headers: lead,
      payload: { kind: 'collection', collectionKey: 'smoke', caseIds: ['238'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      caseIds: ['238'],
      kind: 'collection',
      mode: 'regression-collection',
      collectionKey: 'smoke',
    });
  });

  it('errors clearly when suite/campaign needs Squash on the API without caseIds', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/scope',
      headers: engineer,
      payload: { kind: 'suite', projectId: '1' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/Squash suite\/campaign scope needs the test-management connector/i);
  });
});
