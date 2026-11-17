import type { SecretMaterial } from '@qa/domain';

const MASK = '[REDACTED]';

const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Scrubs registered secret values and common token shapes from strings and nested JSON. */
export class SecretRedactor {
  private readonly values = new Set<string>();

  register(secret: SecretMaterial): void {
    for (const v of Object.values(secret)) {
      if (typeof v === 'string' && v.length >= 6) this.values.add(v);
    }
  }

  redactString(s: string): string {
    let out = s;
    for (const v of this.values) out = out.replace(new RegExp(escape(v), 'g'), MASK);
    for (const p of TOKEN_PATTERNS) out = out.replace(p, MASK);
    return out;
  }

  redact<T>(value: T): T {
    return this.walk(value, 0) as T;
  }

  private walk(v: unknown, depth: number): unknown {
    if (depth > 20) return v;
    if (typeof v === 'string') return this.redactString(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, depth + 1));
    if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.walk(x, depth + 1);
      return out;
    }
    return v;
  }
}
