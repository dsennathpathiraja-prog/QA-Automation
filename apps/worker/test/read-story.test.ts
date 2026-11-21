import { describe, expect, it, vi } from 'vitest';
import { PlatformError } from '@qa/domain';
import { enrichStoryFromConnector, storyFromWorkItem, workItemRefFromStory } from '../src/read-story';

describe('read-story enrichment', () => {
  it('reads a numeric Azure Boards id or a Jira key from the first line', () => {
    expect(workItemRefFromStory('7189')).toBe('7189');
    expect(workItemRefFromStory('7189\nAcceptance criteria\nPay')).toBe('7189');
    expect(workItemRefFromStory('SHOP-12\nTitle')).toBe('SHOP-12');
    expect(workItemRefFromStory('just a story')).toBeUndefined();
  });

  it('builds a story the planner can split into criteria', () => {
    const story = storyFromWorkItem({
      id: '7189',
      title: 'PayNSure checkout',
      description: 'User pays with a saved card.',
      acceptanceCriteria: 'The saved card is listed\nThe total includes tax',
    });
    expect(story).toContain('7189');
    expect(story).toContain('PayNSure checkout');
    expect(story).toMatch(/Acceptance criteria\nThe saved card is listed\nThe total includes tax/);
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
    expect(out.enrichment.story).toContain('Card is shown');
    expect(out.enrichment.story).toContain('Extra pasted criterion');
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
