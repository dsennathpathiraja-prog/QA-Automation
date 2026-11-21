import type { ConnectorExecutionManager } from '@qa/connector-sdk';
import { isPlatformError } from '@qa/domain';

export interface WorkItemDetails {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

export interface StoryEnrichment {
  story: string;
  workItem: string;
  /** System.Title from the work-item connector (required when fetched). */
  title: string;
  /** Short plain-text description for the Read Done line (optional). */
  descriptionExcerpt?: string;
  fetched: boolean;
}

/** Outcome of loading a work item for the Read stage Done line. */
export type EnrichStoryResult =
  | { status: 'enriched'; enrichment: StoryEnrichment }
  | { status: 'missed'; workItem: string; reason: string }
  | { status: 'none' };

/** First line of the Run story field when it looks like an Azure Boards id or a Jira key. */
export function workItemRefFromStory(raw: string): string | undefined {
  const first = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!first) return undefined;
  // Allow `7189 — Guest checkout` or `SHOP-12: Reset password` on one line.
  const inline = first.match(/^(\d{1,10})\s*[—–:\-]\s+\S/)
    ?? first.match(/^([A-Z][A-Z0-9]+-\d+)\s*[—–:\-]\s+\S/i);
  if (inline?.[1]) return inline[1];
  if (/^\d{1,10}$/.test(first) || /^[A-Z][A-Z0-9]+-\d+$/i.test(first)) return first;
  return undefined;
}

/** One-line excerpt of the work item description for the Read Done acknowledgement. */
export function descriptionExcerpt(raw: string | undefined, max = 140): string {
  if (!raw) return '';
  // Description may still be Azure HTML — strip tags for the Done line only.
  const flat = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** Builds the story blob the planner reads: id — title, description, then an Acceptance criteria section. */
export function storyFromWorkItem(item: WorkItemDetails, pastedBelowId = ''): string {
  const head = item.title ? `${item.id} — ${item.title}` : item.id;
  const parts = [head];
  if (item.description) parts.push('', item.description);
  const ac = (item.acceptanceCriteria ?? '').trim();
  if (ac) parts.push('', 'Acceptance criteria', ac);
  const extra = pastedBelowId.trim();
  if (extra) parts.push('', extra);
  return parts.join('\n').trim();
}

/**
 * When the Run tab only has a work item id, load title / description / acceptance criteria
 * from the bound work-item connector. Pasted lines under the id are kept as extra input.
 */
export async function enrichStoryFromConnector(input: {
  story: string;
  connectors?: ConnectorExecutionManager;
  actor: { type: 'step'; id: string; executionId: string; stepId: string };
}): Promise<EnrichStoryResult> {
  const id = workItemRefFromStory(input.story);
  if (!id) return { status: 'none' };
  if (!input.connectors) {
    return {
      status: 'missed',
      workItem: id,
      reason: 'No connector manager is available on the worker, so the work item title was not loaded.',
    };
  }
  const pasted = input.story.includes('\n') ? input.story.slice(input.story.indexOf('\n') + 1) : '';
  try {
    const item = await input.connectors.invoke<WorkItemDetails>({
      role: 'workItemSource',
      capability: 'workitem.read',
      input: { id },
      actor: input.actor,
    });
    if (!item?.id) {
      return {
        status: 'missed',
        workItem: id,
        reason: 'The work-item connector returned no item for this id, so the title was not loaded.',
      };
    }
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const description = typeof item.description === 'string' ? item.description : undefined;
    const excerpt = descriptionExcerpt(description);
    // Succeeded invoke with an empty title still leaves the story blob as the bare id —
    // treat that as a miss so Read fails clearly instead of writing Title _(not loaded)_.
    if (!title) {
      return {
        status: 'missed',
        workItem: String(item.id),
        reason: description
          ? 'The work-item connector returned no System.Title for this id (description was present). Rebuild the worker after the expand=All field-mapping fix, then run Test connection on Azure Boards.'
          : 'The work-item connector returned no System.Title or description for this id. Confirm workitem.read is granted, rebuild the worker, and re-run Test connection on Azure Boards.',
      };
    }
    return {
      status: 'enriched',
      enrichment: {
        story: storyFromWorkItem(
          {
            id: String(item.id),
            title,
            description,
            acceptanceCriteria: typeof item.acceptanceCriteria === 'string' ? item.acceptanceCriteria : undefined,
          },
          pasted,
        ),
        workItem: String(item.id),
        title,
        descriptionExcerpt: excerpt || undefined,
        fetched: true,
      },
    };
  } catch (e) {
    if (isPlatformError(e) && (e.errorClass === 'denied' || e.errorClass === 'not-found' || e.errorClass === 'auth')) {
      return {
        status: 'missed',
        workItem: id,
        reason: e.message || 'The work-item connector could not be read, so the title was not loaded.',
      };
    }
    throw e;
  }
}
