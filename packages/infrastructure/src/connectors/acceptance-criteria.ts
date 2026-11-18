/** Flattens an Atlassian document (Jira Cloud description) to plain text. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === 'string' && (!n.content || n.content.length === 0)) return n.text;
  const parts = (n.content ?? []).map((c) => adfToText(c));
  const sep = n.type === 'doc' || n.type === 'bulletList' || n.type === 'orderedList' ? '\n' : n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' ? '\n' : '';
  return parts.join(sep).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Takes the acceptance-criteria section out of a description.
 * Accepts a markdown heading or a "Acceptance criteria:" label. Returns undefined when the section is absent.
 */
export function acceptanceCriteriaFromDescription(text: string): string | undefined {
  const flat = text.replace(/\r/g, '');
  const headed = flat.match(/(?:^|\n)#{1,6}\s*acceptance criteria\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/i);
  if (headed?.[1]?.trim()) return headed[1].trim();
  const labelled = flat.match(/acceptance criteria\s*:\s*([\s\S]*?)(?=\n[A-Z][A-Za-z ]{2,40}:\s|$)/i);
  if (labelled?.[1]?.trim()) return labelled[1].trim();
  const lines = flat.split('\n');
  const idx = lines.findIndex((l) => /^acceptance criteria\s*:?\s*$/i.test(l.trim()));
  const rest = idx >= 0 ? lines.slice(idx + 1).join('\n').trim() : '';
  return rest.length > 0 ? rest : undefined;
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return adfToText(value);
  return '';
}
