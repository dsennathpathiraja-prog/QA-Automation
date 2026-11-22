import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@qa/domain';
import {
  descriptionExcerpt,
  enrichStoryFromConnector,
  storyFromWorkItem,
  workItemDetailsFromReadResult,
  workItemRefFromStory,
} from '../src/read-story';

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const wi2357 = JSON.parse(readFileSync(join(fixtureDir, 'fixtures/wi-2357-expand-all.json'), 'utf8')) as Record<string, unknown>;

describe('read-story enrichment', () => {
  it('maps WI 2357 expand=All fields into title + description HTML + context', () => {
    const mapped = workItemDetailsFromReadResult(wi2357, '2357');
    expect(mapped).toMatchObject({
      id: '2357',
      title: 'Order Amount Placement in Escrow Notification Template',
      type: 'Requirement',
      state: 'Proposed',
      areaPath: 'PayNSure\\Escrow',
      iterationPath: 'PayNSure\\Sprint 12',
      priority: '2',
      valueArea: 'Business',
      requirementType: 'Feature',
      parentId: '2353',
    });
    expect(mapped?.description).toContain('<div>');
    expect(mapped?.description).toMatch(/Amount Placement in escrow Notification/);
    expect(mapped?.acceptanceCriteriaHtml).toContain('<img');

    const wrappedDataBody = workItemDetailsFromReadResult({ data: wi2357 }, '2357');
    expect(wrappedDataBody?.title).toBe('Order Amount Placement in Escrow Notification Template');
    expect(wrappedDataBody?.description).toContain('<h2>1. Title</h2>');
    expect(wrappedDataBody?.parentId).toBe('2353');

    const wrappedFieldsOnly = workItemDetailsFromReadResult({ data: (wi2357 as { fields: unknown }).fields }, '2357');
    expect(wrappedFieldsOnly?.title).toBe('Order Amount Placement in Escrow Notification Template');
    expect(wrappedFieldsOnly?.areaPath).toBe('PayNSure\\Escrow');
  });

  it('enriches story blob + fields from a raw WIT 2357-shaped invoke result', async () => {
    const invoke = vi.fn().mockResolvedValue(wi2357);
    const out = await enrichStoryFromConnector({
      story: '2357',
      connectors: { invoke } as never,
      actor: { type: 'step', id: 'read_story', executionId: 'run-1', stepId: 'read_story' },
    });
    expect(out.status).toBe('enriched');
    if (out.status !== 'enriched') return;
    expect(out.enrichment.title).toBe('Order Amount Placement in Escrow Notification Template');
    expect(out.enrichment.story).toMatch(/^2357 — Order Amount Placement in Escrow Notification Template/);
    expect(out.enrichment.story).toContain('Work item fields');
    expect(out.enrichment.story).toMatch(/Type: Requirement/);
    expect(out.enrichment.story).toMatch(/Parent: 2353/);
    expect(out.enrichment.story).toContain('<div>');
    expect(out.enrichment.story).toMatch(/Acceptance criteria/);
    expect(out.enrichment.descriptionExcerpt).toMatch(/Amount Placement/i);
    expect(out.enrichment.fields).toMatchObject({
      type: 'Requirement',
      state: 'Proposed',
      parentId: '2353',
      priority: '2',
      valueArea: 'Business',
    });
    expect(out.enrichment.fields.descriptionHtml).toContain('<h2>1. Title</h2>');
    expect(out.enrichment.fields.acceptanceCriteriaHtml).toContain('<img');
  });

  it('reads a numeric Azure Boards id or a Jira key from the first line', () => {
    expect(workItemRefFromStory('7189')).toBe('7189');
    expect(workItemRefFromStory('7189\nAcceptance criteria\nPay')).toBe('7189');
    expect(workItemRefFromStory('SHOP-12\nTitle')).toBe('SHOP-12');
    expect(workItemRefFromStory('7189 — Guest checkout')).toBe('7189');
    expect(workItemRefFromStory('SHOP-12: Reset password')).toBe('SHOP-12');
    expect(workItemRefFromStory('just a story')).toBeUndefined();
  });

  it('builds a story the planner can split into criteria', () => {
    const story = storyFromWorkItem({
      id: '7189',
      title: 'PayNSure checkout',
      description: 'User pays with a saved card.',
      acceptanceCriteria: 'The saved card is listed\nThe total includes tax',
    });
    expect(story).toMatch(/^7189 — PayNSure checkout/);
    expect(story).toMatch(/Acceptance criteria\nThe saved card is listed\nThe total includes tax/);
  });

  it('shortens a description for the Read Done line', () => {
    expect(descriptionExcerpt('Short note.')).toBe('Short note.');
    expect(descriptionExcerpt('One  two\nthree')).toBe('One two three');
    const long = 'Order transactions calculation flow update to match new payment settlement and reasons with more detail about ledger rows and fees.';
    expect(descriptionExcerpt(long, 60).endsWith('…')).toBe(true);
    expect(descriptionExcerpt(long, 60).length).toBeLessThanOrEqual(60);
  });

  it('loads the work item from the connector and keeps pasted lines', async () => {
    const invoke = vi.fn().mockResolvedValue({
      id: '7189',
      title: 'PayNSure checkout',
      description: 'Intro\n\nAcceptance Criteria\n- Card is shown\n- Tax is included',
      acceptanceCriteria: 'Card is shown\nTax is included',
    });
    const out = await enrichStoryFromConnector({
      story: '7189\nExtra pasted criterion',
      connectors: { invoke } as never,
      actor: { type: 'step', id: 'read_story', executionId: 'run-1', stepId: 'read_story' },
    });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ role: 'workItemSource', capability: 'workitem.read', input: { id: '7189' } }));
    expect(out.status).toBe('enriched');
    if (out.status !== 'enriched') return;
    expect(out.enrichment.fetched).toBe(true);
    expect(out.enrichment.workItem).toBe('7189');
    expect(out.enrichment.title).toBe('PayNSure checkout');
    expect(out.enrichment.descriptionExcerpt).toMatch(/Intro/);
    expect(out.enrichment.story).toMatch(/^7189 — PayNSure checkout/);
    expect(out.enrichment.story).toContain('Card is shown');
    expect(out.enrichment.story).toContain('Extra pasted criterion');
  });

  it('treats a Succeeded read with an empty System.Title as a miss', async () => {
    const invoke = vi.fn().mockResolvedValue({
      id: '3421',
      title: '  ',
      description: 'Ledger rows settle with the new payment reasons.',
    });
    const out = await enrichStoryFromConnector({
      story: '3421',
      connectors: { invoke } as never,
      actor: { type: 'step', id: 'read_story', executionId: 'run-1', stepId: 'read_story' },
    });
    expect(out.status).toBe('missed');
    if (out.status !== 'missed') return;
    expect(out.workItem).toBe('3421');
    expect(out.reason).toMatch(/System\.Title/);
  });

  it('reports a miss when the connector is missing or denied', async () => {
    const missing = await enrichStoryFromConnector({
      story: '7189',
      actor: { type: 'step', id: 'a', executionId: 'b', stepId: 'a' },
    });
    expect(missing.status).toBe('missed');
    if (missing.status === 'missed') {
      expect(missing.workItem).toBe('7189');
      expect(missing.reason).toMatch(/title was not loaded/i);
    }

    const invoke = vi.fn().mockRejectedValue(new PlatformError('denied', 'No work-item connector is bound'));
    const denied = await enrichStoryFromConnector({
      story: '7189',
      connectors: { invoke } as never,
      actor: { type: 'step', id: 'a', executionId: 'b', stepId: 'a' },
    });
    expect(denied.status).toBe('missed');
    if (denied.status === 'missed') {
      expect(denied.workItem).toBe('7189');
      expect(denied.reason).toMatch(/No work-item connector is bound/);
    }
  });

  it('returns none when the story has no work item id', async () => {
    expect(await enrichStoryFromConnector({
      story: 'just a pasted story',
      actor: { type: 'step', id: 'a', executionId: 'b', stepId: 'a' },
    })).toEqual({ status: 'none' });
  });
});
