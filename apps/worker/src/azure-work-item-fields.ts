/**
 * Pure Azure WIT field unwrap helpers for Read story.
 * Kept in the worker (not @qa/infrastructure) so non-composition-root modules stay layer-clean.
 */

const FIELD_KEYS = ['System.Title', 'System.Description', 'System.State', 'System.WorkItemType'] as const;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(input: string | null | undefined): string {
  if (!input) return '';
  const withBreaks = input
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  const decoded = stripped.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#x')) return safeCodePoint(parseInt(e.slice(2), 16), m);
    if (e.startsWith('#')) return safeCodePoint(parseInt(e.slice(1), 10), m);
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return decoded
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeCodePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

function textOf(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const obj = value as { value?: unknown; text?: unknown; html?: unknown; name?: unknown };
    if (typeof obj.html === 'string') return obj.html;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.name === 'string') return obj.name;
  }
  return '';
}

function fieldsFromArray(rows: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const item = row as { referenceName?: unknown; name?: unknown; value?: unknown };
    const key = typeof item.referenceName === 'string' ? item.referenceName
      : typeof item.name === 'string' ? item.name
        : '';
    if (key) out[key] = item.value;
  }
  return out;
}

/** Unwrap WIT `{ fields }`, `{ data: { fields } }`, list wrappers, and referenceName arrays. */
export function azureWorkItemFields(body: unknown, depth = 0): Record<string, unknown> {
  if (!body || typeof body !== 'object' || depth > 4) return {};
  const root = body as Record<string, unknown>;

  const fromCandidate = (candidate: unknown): Record<string, unknown> => {
    if (!candidate || typeof candidate !== 'object') return {};
    if (Array.isArray(candidate)) return fieldsFromArray(candidate);
    const map = candidate as Record<string, unknown>;
    const nested = map.fields;
    if (Array.isArray(nested)) {
      const fromNested = fieldsFromArray(nested);
      if (FIELD_KEYS.some((k) => k in fromNested)) return fromNested;
    }
    if (
      nested
      && typeof nested === 'object'
      && !Array.isArray(nested)
      && FIELD_KEYS.some((k) => k in (nested as object))
    ) {
      return nested as Record<string, unknown>;
    }
    if (FIELD_KEYS.some((k) => k in map)) return map;
    return {};
  };

  const direct = fromCandidate(root.fields);
  if (Object.keys(direct).length > 0) return direct;

  const value = root.value;
  if (Array.isArray(value) && value[0]) {
    const fromRow = fromCandidate((value[0] as { fields?: unknown }).fields ?? value[0]);
    if (Object.keys(fromRow).length > 0) return fromRow;
  } else if (value && typeof value === 'object') {
    const fromValue = fromCandidate((value as { fields?: unknown }).fields ?? value);
    if (Object.keys(fromValue).length > 0) return fromValue;
  }

  if ('data' in root && root.data != null) {
    const fromData = azureWorkItemFields(root.data, depth + 1);
    if (Object.keys(fromData).length > 0) return fromData;
  }

  if (FIELD_KEYS.some((k) => k in root)) return root;
  return {};
}

export function azureFieldString(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key];
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as { value?: unknown; text?: unknown; name?: unknown; html?: unknown };
    if (typeof obj.value === 'string') return obj.value.trim();
    if (typeof obj.text === 'string') return obj.text.trim();
    if (typeof obj.html === 'string') return htmlToText(obj.html).trim();
    if (typeof obj.name === 'string') return obj.name.trim();
  }
  return '';
}

export function azureWorkItemTitle(body: unknown): string {
  const fields = azureWorkItemFields(body);
  const fromFields = azureFieldString(fields, 'System.Title');
  if (fromFields) return fromFields;
  if (body && typeof body !== 'object') return '';
  for (const [k, v] of Object.entries(fields)) {
    if (k.toLowerCase() === 'system.title') {
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as { value?: unknown };
        if (typeof obj.value === 'string' && obj.value.trim()) return obj.value.trim();
      }
    }
  }
  return '';
}

export function azureFieldHtml(fields: Record<string, unknown>, key: string): string {
  const raw = fields[key];
  if (typeof raw === 'string') return raw.trim();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as { html?: unknown; value?: unknown; text?: unknown };
    if (typeof obj.html === 'string') return obj.html.trim();
    if (typeof obj.value === 'string') return obj.value.trim();
    if (typeof obj.text === 'string') return obj.text.trim();
  }
  return textOf(raw).trim();
}
