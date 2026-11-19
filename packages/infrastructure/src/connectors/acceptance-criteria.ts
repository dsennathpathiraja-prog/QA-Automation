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

const stripBullet = (line: string) => line.replace(/^[\s>*\-•\d.)]+/, '').trim();

const isHeading = (line: string) => /^(#{1,6}\s|acceptance criteria\b|repro(duction)? steps\b|description\b|notes?\b|business rules?\b)/i.test(line);

const isGwt = (line: string) => /^(given|when|then|and)\b/i.test(line);

/**
 * Splits an acceptance-criteria blob into one criterion per line / Given-When-Then block.
 * Bullet markers and numbering are removed. Empty and heading-only lines are dropped.
 */
export function splitAcceptanceCriteria(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const out: string[] = [];
  let gwt: string[] = [];
  const flushGwt = () => {
    if (gwt.length === 0) return;
    out.push(gwt.join(' '));
    gwt = [];
  };
  for (const raw of lines) {
    const line = stripBullet(raw);
    if (!line || isHeading(line) && !isGwt(line)) {
      flushGwt();
      continue;
    }
    if (isGwt(line)) {
      if (/^given\b/i.test(line) && gwt.length > 0) flushGwt();
      gwt.push(line);
      if (/^then\b/i.test(line)) flushGwt();
      continue;
    }
    flushGwt();
    out.push(line);
  }
  flushGwt();
  return out.slice(0, 40);
}

/**
 * When there is no Acceptance Criteria section, pull scenario cues from the body:
 * bullets, numbered lines, and Given/When/Then blocks.
 */
export function scenarioCuesFromDescription(text: string): string[] {
  const fromSection = acceptanceCriteriaFromDescription(text);
  if (fromSection) return splitAcceptanceCriteria(fromSection);
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean);
  const bullets = lines.filter((line) => /^([\-*•]|\d+[.)])\s+\S/.test(line));
  if (bullets.length > 0) return splitAcceptanceCriteria(bullets.join('\n'));
  const gwtLines = lines.filter((line) => isGwt(stripBullet(line)));
  if (gwtLines.length > 0) return splitAcceptanceCriteria(gwtLines.join('\n'));
  return [];
}

export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return adfToText(value);
  return '';
}
