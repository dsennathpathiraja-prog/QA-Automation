import { describe, expect, it } from 'vitest';
import { AutomationService } from '@qa/application';
import { InMemoryAuditSink, InMemoryAutomationRepository } from '../src';

const actor = { id: 'lead' };

function setup() {
  const automation = new InMemoryAutomationRepository();
  const audit = new InMemoryAuditSink();
  const service = new AutomationService({ automation, audit });
  return { automation, audit, service };
}

describe('AutomationService (Phase 8 E6)', () => {
  it('registers a draft asset, maps a Squash case, and resolves to the platform asset id', async () => {
    const s = setup();
    const asset = await s.service.register(actor, {
      key: 'QAP-7259-1',
      name: 'Positive: checkout',
      scriptPath: 'tests/app/7259.spec.js',
      scriptBody: "import { test } from '@playwright/test';\n",
      squashCaseId: '238',
      squashReference: 'QAP-7259-1',
    });
    expect(asset).toMatchObject({ key: 'QAP-7259-1', status: 'draft', scriptPath: 'tests/app/7259.spec.js' });
    const resolved = await s.service.resolveBySquashCaseId('238');
    expect(resolved).toMatchObject({
      squashCaseId: '238',
      assetId: asset.id,
      assetKey: 'QAP-7259-1',
      status: 'draft',
      approved: false,
    });
    expect(s.audit.entries.map((e) => e.action)).toEqual(['automation.register', 'automation.map']);
  });

  it('approves a draft so resolve reports approved for Regression', async () => {
    const s = setup();
    const asset = await s.service.register(actor, {
      key: 'QAP-1',
      name: 'Case',
      scriptPath: 'tests/a.spec.js',
      squashCaseId: '42',
    });
    const approved = await s.service.approve(actor, asset.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedBy).toBe('lead');
    expect(await s.service.resolveBySquashCaseId('42')).toMatchObject({ assetId: asset.id, approved: true, status: 'approved' });
    expect(s.audit.entries.some((e) => e.action === 'automation.approve')).toBe(true);
  });

  it('re-registers the same key without duplicating, and upserts the Squash mapping', async () => {
    const s = setup();
    const first = await s.service.seedFromPublish(actor, {
      key: 'QAP-1',
      name: 'v1',
      scriptPath: 'tests/v1.spec.js',
      squashCaseId: '9',
    });
    const second = await s.service.seedFromPublish(actor, {
      key: 'QAP-1',
      name: 'v2',
      scriptPath: 'tests/v2.spec.js',
      squashCaseId: '9',
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('v2');
    expect(second.scriptPath).toBe('tests/v2.spec.js');
    expect(await s.service.listMappings()).toHaveLength(1);
    expect(await s.service.resolveBySquashCaseId('9')).toMatchObject({ assetId: first.id, scriptPath: 'tests/v2.spec.js' });
  });

  it('keeps approved status when re-registering an approved asset', async () => {
    const s = setup();
    const asset = await s.service.register(actor, { key: 'QAP-keep', name: 'A', scriptPath: 'tests/a.spec.js' });
    await s.service.approve(actor, asset.id);
    const again = await s.service.register(actor, { key: 'QAP-keep', name: 'B', scriptPath: 'tests/b.spec.js' });
    expect(again.status).toBe('approved');
    expect(again.name).toBe('B');
  });

  it('lists mappings with asset details and refuses an unknown Squash case', async () => {
    const s = setup();
    await s.service.register(actor, {
      key: 'QAP-list',
      name: 'Listed',
      scriptPath: 'tests/list.spec.js',
      squashCaseId: '100',
    });
    const listed = await s.service.listMappings();
    expect(listed).toEqual([
      expect.objectContaining({
        squashCaseId: '100',
        assetKey: 'QAP-list',
        scriptPath: 'tests/list.spec.js',
        status: 'draft',
      }),
    ]);
    await expect(s.service.resolveBySquashCaseId('missing')).rejects.toMatchObject({ errorClass: 'not-found' });
  });
});
