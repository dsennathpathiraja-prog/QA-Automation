/**
 * Parse Playwright MCP page-state markdown (### Page state / ```yaml … ```)
 * into fields the Explore UI artifact and planner can use.
 */

export interface SnapshotCues {
  links: string[];
  buttons: string[];
  fields: string[];
  headings: string[];
}

export interface ParsedPageSnapshot {
  raw: string;
  url: string;
  title: string;
  /** Accessibility tree YAML (prefer this in MD artifacts). */
  yaml: string;
  cues: SnapshotCues;
}

const namedRole = (role: string, yaml: string, limit = 24): string[] => {
  const re = new RegExp(`\\b${role}\\s+"((?:\\\\.|[^"\\\\])*)"`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml)) !== null && out.length < limit) {
    const name = m[1]!.replace(/\\"/g, '"').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
};

/** Extract planner-facing cues from an aria YAML tree. */
export function snapshotCuesFromYaml(yaml: string): SnapshotCues {
  const src = yaml || '';
  return {
    links: namedRole('link', src),
    buttons: namedRole('button', src),
    fields: [...namedRole('textbox', src), ...namedRole('searchbox', src), ...namedRole('combobox', src)],
    headings: namedRole('heading', src),
  };
}

/** Parse MCP `browser_snapshot` / navigate tool text into URL, title, and YAML. */
export function parseMcpPageSnapshot(raw: string): ParsedPageSnapshot {
  const text = (raw ?? '').trim();
  const url = /(?:^|\n)-\s*Page URL:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
  const title = /(?:^|\n)-\s*Page Title:\s*(.*)/i.exec(text)?.[1]?.trim() ?? '';
  const fenced = /```yaml\r?\n([\s\S]*?)```/i.exec(text)?.[1]?.trim() ?? '';
  // Fallback: body after "Page Snapshot:" when fences are missing.
  const afterLabel = !fenced
    ? (/Page Snapshot:\s*\r?\n([\s\S]+)$/i.exec(text)?.[1]?.trim() ?? '')
    : '';
  const yaml = fenced || afterLabel;
  return {
    raw: text,
    url,
    title,
    yaml,
    cues: snapshotCuesFromYaml(yaml || text),
  };
}

/**
 * True when the snapshot has enough structure for playwright-test-planner
 * (interactive roles / labels / substantial YAML) — not title-only or _(empty)_.
 */
export function snapshotIsActionable(parsed: ParsedPageSnapshot): boolean {
  if (!parsed.raw && !parsed.yaml) return false;
  if (/No open tabs/i.test(parsed.raw)) return false;
  if (/^about:blank$/i.test(parsed.url) || /^chrome-error:\/\//i.test(parsed.url)) return false;
  if (/ERR_NAME_NOT_RESOLVED|DNS_PROBE|This site (can.t|cannot) be reached/i.test(parsed.raw)) return false;
  const cues = parsed.cues;
  if (cues.links.length + cues.buttons.length + cues.fields.length + cues.headings.length > 0) return true;
  if (/\b(button|link|textbox|heading|searchbox|checkbox|combobox|listitem|menuitem|tab)\b/i.test(parsed.yaml || parsed.raw)) {
    return true;
  }
  // Substantial aria YAML (storefront trees) without named quotes still counts.
  const yaml = (parsed.yaml || '').trim();
  if (yaml.length >= 80) return true;
  return false;
}

/** Compact one-line summary for findings strings. */
export function summarizeSnapshotForFindings(parsed: ParsedPageSnapshot): string {
  const bits: string[] = [];
  if (parsed.title) bits.push(`title="${parsed.title}"`);
  const { links, buttons, fields, headings } = parsed.cues;
  if (headings[0]) bits.push(`heading="${headings[0]}"`);
  if (buttons.length) bits.push(`buttons=${buttons.slice(0, 6).map((b) => `"${b}"`).join(',')}`);
  if (links.length) bits.push(`links=${links.slice(0, 6).map((l) => `"${l}"`).join(',')}`);
  if (fields.length) bits.push(`fields=${fields.slice(0, 6).map((f) => `"${f}"`).join(',')}`);
  if (bits.length) return bits.join('; ');
  const yaml = (parsed.yaml || parsed.raw).replace(/\s+/g, ' ').trim();
  return yaml.slice(0, 280);
}

/** Prefer YAML tree for the MD artifact; fall back to raw MCP text. */
export function snapshotArtifactBody(parsed: ParsedPageSnapshot): string {
  if (parsed.yaml.trim()) return parsed.yaml.trim();
  return parsed.raw.trim();
}
