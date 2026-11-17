import { createHash } from 'node:crypto';

export interface AuditEntryInput {
  at: string;
  actorId: string;
  action: string;
  subjectType: string;
  subjectId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditEntry extends AuditEntryInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
};

export function chainEntry(prev: AuditEntry | undefined, input: AuditEntryInput): AuditEntry {
  const seq = (prev?.seq ?? 0) + 1;
  const prevHash = prev?.hash ?? GENESIS_HASH;
  const hash = createHash('sha256').update(`${seq}|${prevHash}|${canonical(input)}`).digest('hex');
  return { ...input, seq, prevHash, hash };
}

export function verifyChain(entries: readonly AuditEntry[]): { ok: true } | { ok: false; brokenAtSeq: number } {
  let prev: AuditEntry | undefined;
  for (const e of entries) {
    const { seq: _s, prevHash: _p, hash: _h, ...input } = e;
    const expected = chainEntry(prev, input);
    if (expected.seq !== e.seq || expected.prevHash !== e.prevHash || expected.hash !== e.hash) {
      return { ok: false, brokenAtSeq: e.seq };
    }
    prev = e;
  }
  return { ok: true };
}
