const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Squash rich-text fields are HTML. Agents get plain text; markup (including scripts) is dropped, never interpreted. */
export function htmlToText(input: string | null | undefined): string {
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
