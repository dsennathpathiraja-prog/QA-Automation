import type { ConnectorExecutionManager } from '@qa/connector-sdk';
import { isPlatformError } from '@qa/domain';
import {
  azureFieldHtml,
  azureFieldString,
  azureWorkItemFields,
  azureWorkItemTitle,
} from '@qa/infrastructure';

/** Useful Azure Boards / work-item fields for planner + story MD (from expand=All). */
export interface WorkItemDetails {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  acceptanceCriteriaHtml?: string;
  type?: string;
  state?: string;
  areaPath?: string;
  iterationPath?: string;
  priority?: string;
  requirementType?: string;
  valueArea?: string;
  parentId?: string;
}

export interface StoryEnrichment {
  story: string;
  workItem: string;
  /** System.Title from the work-item connector (required when fetched). */
  title: string;
  /** Short plain-text description for the Read Done line (optional). */
  descriptionExcerpt?: string;
  /** Structured fields for story MD Context (and downstream planner params). */
  fields: WorkItemContextFields;
  fetched: boolean;
}

/** Subset surfaced in story.md Context and step params. */
export interface WorkItemContextFields {
  type?: string;
  state?: string;
  areaPath?: string;
  iterationPath?: string;
  priority?: string;
  requirementType?: string;
  valueArea?: string;
  parentId?: string;
  descriptionHtml?: string;
  acceptanceCriteriaHtml?: string;
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

function optString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const t = value.trim();
    return t || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Context bullets + description/AC HTML so the planner sees expand=All fields in the story blob. */
export function storyFromWorkItem(item: WorkItemDetails, pastedBelowId = ''): string {
  const head = item.title ? `${item.id} — ${item.title}` : item.id;
  const parts = [head];
  const meta: string[] = [];
  if (item.type) meta.push(`- Type: ${item.type}`);
  if (item.state) meta.push(`- State: ${item.state}`);
  if (item.areaPath) meta.push(`- Area path: ${item.areaPath}`);
  if (item.iterationPath) meta.push(`- Iteration path: ${item.iterationPath}`);
  if (item.priority) meta.push(`- Priority: ${item.priority}`);
  if (item.requirementType) meta.push(`- Requirement type: ${item.requirementType}`);
  if (item.valueArea) meta.push(`- Value area: ${item.valueArea}`);
  if (item.parentId) meta.push(`- Parent: ${item.parentId}`);
  if (meta.length > 0) parts.push('', 'Work item fields', ...meta);
  if (item.description) parts.push('', 'Description', item.description);
  const acHtml = (item.acceptanceCriteriaHtml ?? '').trim();
  const acPlain = (item.acceptanceCriteria ?? '').trim();
  if (acHtml) parts.push('', 'Acceptance criteria', acHtml);
  else if (acPlain) parts.push('', 'Acceptance criteria', acPlain);
  const extra = pastedBelowId.trim();
  if (extra) parts.push('', extra);
  return parts.join('\n').trim();
}

export function contextFieldsFromDetails(item: WorkItemDetails): WorkItemContextFields {
  return {
    ...(item.type ? { type: item.type } : {}),
    ...(item.state ? { state: item.state } : {}),
    ...(item.areaPath ? { areaPath: item.areaPath } : {}),
    ...(item.iterationPath ? { iterationPath: item.iterationPath } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.requirementType ? { requirementType: item.requirementType } : {}),
    ...(item.valueArea ? { valueArea: item.valueArea } : {}),
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ...(item.description ? { descriptionHtml: item.description } : {}),
    ...((item.acceptanceCriteriaHtml || item.acceptanceCriteria)
      ? { acceptanceCriteriaHtml: item.acceptanceCriteriaHtml || item.acceptanceCriteria }
      : {}),
  };
}

/**
 * Normalize workitem.read output whether the connector returned:
 * - mapped `{ id, title, description, … }`
 * - raw WIT `{ id, fields: { 'System.Title': … } }` (expand=All)
 * - wrapped `{ data: { fields } }` or `{ data: fieldsMap }`
 */
export function workItemDetailsFromReadResult(raw: unknown, fallbackId: string): WorkItemDetails | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const root = raw as Record<string, unknown>;
  const data = root.data;
  const payload: Record<string, unknown> = (
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && (
      'fields' in (data as object)
      || 'title' in (data as object)
      || 'System.Title' in (data as object)
      || 'id' in (data as object)
    )
  )
    ? data as Record<string, unknown>
    : root;

  const fields = azureWorkItemFields(raw);
  const mappedTitle = typeof payload.title === 'string' ? payload.title.trim() : '';
  const title = mappedTitle
    || azureFieldString(fields, 'System.Title')
    || azureWorkItemTitle(raw)
    || azureWorkItemTitle(payload);
  const mappedDescription = typeof payload.description === 'string' ? payload.description : '';
  const description = (mappedDescription.trim()
    || azureFieldHtml(fields, 'System.Description')
    || undefined) || undefined;
  const mappedAc = typeof payload.acceptanceCriteria === 'string' ? payload.acceptanceCriteria : '';
  const mappedAcHtml = typeof payload.acceptanceCriteriaHtml === 'string' ? payload.acceptanceCriteriaHtml : '';
  const acceptanceCriteriaHtml = (mappedAcHtml.trim()
    || azureFieldHtml(fields, 'Microsoft.VSTS.Common.AcceptanceCriteria')
    || undefined) || undefined;
  const acceptanceCriteria = mappedAc.trim() || undefined;
  const idRaw = payload.id ?? root.id ?? fields['System.Id'];
  const id = idRaw != null && String(idRaw).trim() ? String(idRaw).trim() : fallbackId;
  if (!id) return undefined;

  const type = optString(payload.type) || azureFieldString(fields, 'System.WorkItemType') || undefined;
  const state = optString(payload.state) || azureFieldString(fields, 'System.State') || undefined;
  const areaPath = optString(payload.areaPath) || azureFieldString(fields, 'System.AreaPath') || undefined;
  const iterationPath = optString(payload.iterationPath) || azureFieldString(fields, 'System.IterationPath') || undefined;
  const priority = optString(payload.priority) || azureFieldString(fields, 'Microsoft.VSTS.Common.Priority') || undefined;
  const requirementType = optString(payload.requirementType)
    || azureFieldString(fields, 'Microsoft.VSTS.Common.RequirementType')
    || undefined;
  const valueArea = optString(payload.valueArea) || azureFieldString(fields, 'Microsoft.VSTS.Common.ValueArea') || undefined;
  const parentId = optString(payload.parentId)
    || azureFieldString(fields, 'System.Parent')
    || optString(fields['System.Parent'])
    || undefined;

  return {
    id,
    title: title || '',
    ...(description ? { description } : {}),
    ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
    ...(acceptanceCriteriaHtml ? { acceptanceCriteriaHtml } : {}),
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    ...(areaPath ? { areaPath } : {}),
    ...(iterationPath ? { iterationPath } : {}),
    ...(priority ? { priority } : {}),
    ...(requirementType ? { requirementType } : {}),
    ...(valueArea ? { valueArea } : {}),
    ...(parentId ? { parentId } : {}),
  };
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
    const raw = await input.connectors.invoke<unknown>({
      role: 'workItemSource',
      capability: 'workitem.read',
      input: { id },
      actor: input.actor,
    });
    const item = workItemDetailsFromReadResult(raw, id);
    if (!item?.id) {
      return {
        status: 'missed',
        workItem: id,
        reason: 'The work-item connector returned no item for this id, so the title was not loaded.',
      };
    }
    const title = item.title.trim();
    const description = item.description;
    const excerpt = descriptionExcerpt(description);
    // Succeeded invoke with an empty title still leaves the story blob as the bare id —
    // treat that as a miss so Read fails clearly instead of writing Title _(not loaded)_.
    if (!title) {
      return {
        status: 'missed',
        workItem: String(item.id),
        reason: description
          ? 'The work-item connector returned no System.Title for this id after parse (description was present). Check fields.System.Title mapping / rebuild the worker after the expand=All field-mapping fix.'
          : 'The work-item connector returned no System.Title or description for this id after parse. Confirm workitem.read is granted, rebuild the worker, and re-run Test connection on Azure Boards.',
      };
    }
    return {
      status: 'enriched',
      enrichment: {
        story: storyFromWorkItem({ ...item, title }, pasted),
        workItem: String(item.id),
        title,
        descriptionExcerpt: excerpt || undefined,
        fields: contextFieldsFromDetails({ ...item, title }),
        fetched: true,
      },
    };
  } catch (e) {
    if (isPlatformError(e) && (e.errorClass === 'denied' || e.errorClass === 'not-found' || e.errorClass === 'auth' || e.errorClass === 'validation')) {
      return {
        status: 'missed',
        workItem: id,
        reason: e.message || 'The work-item connector could not be read, so the title was not loaded.',
      };
    }
    throw e;
  }
}
