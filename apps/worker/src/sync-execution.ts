import { createHash } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { CaseOutcome } from './run-work-item';

const SQUASH_STATUS: Partial<Record<CaseOutcome['status'], string>> = {
  Passed: 'SUCCESS',
  Failed: 'FAILURE',
  Blocked: 'BLOCKED',
  Skipped: 'UNTESTABLE',
};

const TOKEN_FIX =
  'Replace credentials with a READ_WRITE personal API token (Authorization: Bearer only — not username/password), Test Connection, Switch on, and restart the worker so it picks up the new secret lease.';

const PLATFORM_EVIDENCE = 'Platform evidence is unchanged.';

/**
 * Writes each case result to Squash when the connector can create executions.
 * Optionally uploads screenshots via `tm.attachment.upload` when provided.
 * Attachment failures degrade the sync line and never drop platform screenshots.
 * Uses project name resolution already configured on the Squash connector (for example ToolKit-AgenFlow).
 * Auth must match the create/publish path: Bearer token from the same leased secret bag.
 */
export async function syncCaseResultsToSquash(o: {
  results: CaseOutcome[];
  workItem: string;
  squashIdForCase: (testCaseId: string, name: string) => Promise<string | undefined>;
  upsert: (testCaseId: string) => Promise<{ id: string; created: boolean }>;
  updateStatus: (executionId: string, status: string, actualResult?: string) => Promise<void>;
  /** When set, uploads each case screenshot to the Squash execution after status update. */
  uploadAttachment?: (input: {
    executionId: string;
    testCaseId: string;
    name: string;
    contentBase64: string;
    sha256: string;
  }) => Promise<{ id: string }>;
}): Promise<{ results: CaseOutcome[]; summary: string }> {
  if (o.results.length === 0) return { results: o.results, summary: `No cases to sync for ${o.workItem}.` };
  const out: CaseOutcome[] = [];
  let synced = 0;
  let attached = 0;
  let error = '';
  let attachmentError = '';
  for (const row of o.results) {
    if (error) {
      out.push(row);
      continue;
    }
    try {
      const squashCaseId = await o.squashIdForCase(row.testCaseId, row.name);
      if (!squashCaseId) {
        out.push(row);
        if (!error) error = `No Squash case id for "${row.name}". Store cases in Squash on publish first.`;
        continue;
      }
      const mapped = SQUASH_STATUS[row.status];
      if (!mapped) {
        out.push(row);
        continue;
      }
      const execution = await o.upsert(squashCaseId);
      await o.updateStatus(execution.id, mapped, row.message);
      out.push({ ...row, squashExecutionId: execution.id });
      synced += 1;

      if (o.uploadAttachment && row.screenshotPng && !attachmentError) {
        try {
          const contentBase64 = row.screenshotPng;
          const sha256 = createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex');
          await o.uploadAttachment({
            executionId: execution.id,
            testCaseId: row.testCaseId,
            name: screenshotFileName(row.name, contentBase64),
            contentBase64,
            sha256,
          });
          attached += 1;
        } catch (e) {
          attachmentError = clarifySquashSyncError(e);
        }
      }
    } catch (e) {
      error = clarifySquashSyncError(e);
      out.push(row);
    }
  }
  return { results: out, summary: buildSyncSummary({ workItem: o.workItem, synced, attached, wantedAttachments: countWantedAttachments(o), error, attachmentError }) };
}

function countWantedAttachments(o: {
  results: CaseOutcome[];
  uploadAttachment?: unknown;
}): number {
  if (!o.uploadAttachment) return 0;
  return o.results.filter((r) => !!r.screenshotPng && SQUASH_STATUS[r.status]).length;
}

function buildSyncSummary(o: {
  workItem: string;
  synced: number;
  attached: number;
  wantedAttachments: number;
  error: string;
  attachmentError: string;
}): string {
  const base = `Cases ran for ${o.workItem}.`;
  if (o.error && o.synced === 0) return `${base} Squash was not updated: ${o.error}`;
  if (o.error) return `${base} Squash accepted ${o.synced} then stopped: ${o.error}`;

  const statusPart = `Squash recorded ${o.synced} execution status${o.synced === 1 ? '' : 'es'}`;
  if (o.wantedAttachments === 0) return `${base} ${statusPart}.`;

  if (o.attachmentError) {
    const partial = o.attached > 0 ? ` uploaded ${o.attached} screenshot attachment${o.attached === 1 ? '' : 's'} then` : '';
    return `${base} ${statusPart}.${partial} Screenshot attachments were not uploaded: ${o.attachmentError} ${PLATFORM_EVIDENCE}`;
  }
  if (o.attached === 0) return `${base} ${statusPart}.`;
  return `${base} ${statusPart} and uploaded ${o.attached} screenshot attachment${o.attached === 1 ? '' : 's'}.`;
}

function screenshotFileName(caseName: string, contentBase64: string): string {
  const safe = caseName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'case';
  const jpeg = contentBase64.startsWith('/9j/');
  return `${safe}-screenshot.${jpeg ? 'jpg' : 'png'}`;
}

/** Pulls a numeric Squash id from a Test Cases summary like "Squash 42". */
export function squashIdFromSummary(summary: string): string | undefined {
  const m = /^Squash (\d+)$/.exec(summary.trim());
  return m?.[1];
}

export function clarifySquashSyncError(e: unknown): string {
  const raw = e instanceof PlatformError ? e.message : 'Squash did not accept the execution status.';
  if (/read-only|cannot change|WRITE/i.test(raw) && !/READ_WRITE|personal API token/i.test(raw)) {
    return `The Squash connector cannot write execution status. ${TOKEN_FIX}`;
  }
  if (/rejected the API token|expired, revoked|not a token|Basic authentication|secret lease|Unauthorized/i.test(raw)) {
    if (/Test Connection|Switch on|restart the worker/i.test(raw)) return raw;
    return `${raw} ${TOKEN_FIX}`;
  }
  return raw;
}

/** Alert severity for the Executions sync line (status + optional attachment degrade). */
export function squashSyncSeverity(message: string | undefined): 'info' | 'warning' | 'error' {
  if (!message) return 'info';
  if (/Squash was not updated|No writable Squash|was not available/i.test(message)) return 'warning';
  if (/Screenshot attachments were not uploaded|then stopped:/i.test(message)) return 'warning';
  return 'info';
}
