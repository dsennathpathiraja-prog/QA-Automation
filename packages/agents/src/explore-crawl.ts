/**
 * Bounded multi-page UI explore crawl helpers (app-agnostic).
 * From any allowlisted start URL: discover in-app links/buttons/tabs/menus, optionally
 * boost by story/AC keywords, skip destructive actions, keep SPA hash + same-URL views.
 */

export const DEFAULT_EXPLORE_MAX_PAGES = 5;
export const DEFAULT_EXPLORE_MAX_DEPTH = 2;
/** Soft wall-clock budget for crawl clicks after the first page (fail soft with partial evidence). */
export const DEFAULT_EXPLORE_MAX_MS = 45_000;

export type CrawlTargetKind = 'link' | 'button' | 'route';

export interface CrawlTarget {
  kind: CrawlTargetKind;
  /** Visible label used for click / findings. */
  label: string;
  /** Absolute href when known (may include hash for SPA routes). */
  href?: string;
  score: number;
  depth: number;
  /** True when navigation is hash-only (same path, different `#fragment`). */
  hashNav?: boolean;
}

export interface CrawlBounds {
  maxPages: number;
  maxDepth: number;
  maxMs: number;
  startedAt: number;
}

export interface CrawlKeywords {
  /** Story search terms / AC tokens. */
  terms: string[];
  /** Acceptance criteria lines. */
  criteria: string[];
  /** Likely surfaces from story analysis. */
  surfaces: string[];
}

/** Labels that must not be clicked during observe-only Explore UI. */
const DESTRUCTIVE_LABEL = /\b(delete|destroy|remove all|wipe|purge|logout|log\s*out|sign\s*out|unsubscribe|reset\s+password|change\s+password|pay\s+now|submit\s+payment|confirm\s+purchase|place\s+order|buy\s+now|complete\s+purchase|cancel\s+subscription|close\s+account|erase)\b/i;

/** Non-navigational schemes (bare `#` is skip; `#section` hash routes are in-app nav). */
const SKIP_SCHEME = /^(mailto:|tel:|sms:|javascript:|data:)/i;

/** Generic nav vocabulary — not product-specific. Story/AC terms are an optional boost. */
const NAV_HINT = /\b(nav|menu|home|back|next|continue|account|settings|profile|dashboard|admin|help|about|search|filter|tab|sidebar|overview|details|list|create|edit|view|reports?|users?|projects?|inbox|messages?|notifications?|templates?|preview|catalog|products?|orders?|cart|checkout|summary)\b/i;

export function createCrawlBounds(input?: {
  maxPages?: number;
  maxDepth?: number;
  maxMs?: number;
  now?: number;
}): CrawlBounds {
  const maxPages = Math.max(1, Math.min(12, input?.maxPages ?? DEFAULT_EXPLORE_MAX_PAGES));
  const maxDepth = Math.max(0, Math.min(4, input?.maxDepth ?? DEFAULT_EXPLORE_MAX_DEPTH));
  const maxMs = Math.max(5_000, Math.min(120_000, input?.maxMs ?? DEFAULT_EXPLORE_MAX_MS));
  return {
    maxPages,
    maxDepth,
    maxMs,
    startedAt: input?.now ?? Date.now(),
  };
}

export function crawlBudgetOpen(bounds: CrawlBounds, pagesCaptured: number, now = Date.now()): boolean {
  if (pagesCaptured >= bounds.maxPages) return false;
  if (now - bounds.startedAt >= bounds.maxMs) return false;
  return true;
}

/** Same host (and optional port) as the explore start URL — stay on story surface host. */
export function sameExploreHost(baseUrl: string, candidateUrl: string): boolean {
  try {
    const base = new URL(baseUrl);
    const cand = new URL(candidateUrl, base);
    return base.protocol === cand.protocol && base.host.toLowerCase() === cand.host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Normalize an explore URL for comparison.
 * When `keepHash` is true, SPA fragments like `#order-summary` stay distinct from the base path.
 */
export function normalizeExploreUrl(
  url: string,
  base?: string,
  opts?: { keepHash?: boolean },
): string | undefined {
  try {
    const u = base ? new URL(url, base) : new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (!opts?.keepHash) u.hash = '';
    // Drop trailing slash for fingerprinting (keep root as `/`).
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

/** Resolve href (including in-page `#fragment`) against the current page — keeps hash. */
export function resolveExploreHref(href: string, pageUrl: string): string | undefined {
  const t = (href || '').trim();
  if (!t || t === '#') return undefined;
  if (SKIP_SCHEME.test(t)) return undefined;
  return normalizeExploreUrl(t, pageUrl, { keepHash: true });
}

export function hrefHasNavigationalHash(href: string | undefined): boolean {
  if (!href) return false;
  try {
    const u = new URL(href, 'http://explore.invalid');
    return Boolean(u.hash && u.hash.length > 1);
  } catch {
    return /^#[\w./-]+/.test(href.trim());
  }
}

/** True when candidate differs only by hash (or is a relative `#fragment`). */
export function isHashOnlyNavigation(fromUrl: string, toUrl: string): boolean {
  try {
    const a = new URL(fromUrl);
    const b = new URL(toUrl, fromUrl);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString() && hrefHasNavigationalHash(toUrl);
  } catch {
    return false;
  }
}

export function isDestructiveNavLabel(label: string): boolean {
  return DESTRUCTIVE_LABEL.test((label || '').trim());
}

export function isSkippableHref(href: string | undefined): boolean {
  if (!href) return false;
  const t = href.trim();
  if (!t || t === '#') return true;
  if (SKIP_SCHEME.test(t)) return true;
  // Bare hash-only junk, not `#order-summary`.
  if (/^#+$/.test(t)) return true;
  return false;
}

/**
 * Score a click/nav target for crawl order.
 * Baseline discovery works with empty keywords (any app); story/AC terms are an optional boost.
 */
export function scoreCrawlTarget(
  label: string,
  href: string | undefined,
  keywords: CrawlKeywords,
): number {
  const labelL = (label || '').toLowerCase();
  const hrefL = (href || '').toLowerCase();
  const blob = `${labelL} ${hrefL}`;
  if (!labelL && !hrefL) return -100;
  if (isDestructiveNavLabel(labelL)) return -100;
  if (isSkippableHref(href)) return -100;

  // Positive baseline so unlabeled product UIs still get crawled within bounds.
  let score = 2;
  if (NAV_HINT.test(blob)) score += 4;
  if (hrefHasNavigationalHash(href)) score += 3;

  const terms = [
    ...keywords.terms,
    ...keywords.criteria.flatMap((c) => c.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)),
    ...keywords.surfaces,
  ].map((t) => t.toLowerCase().trim()).filter(Boolean);

  for (const term of [...new Set(terms)].slice(0, 40)) {
    if (term.length < 3) continue;
    if (blob.includes(term)) score += term.length >= 6 ? 6 : 3;
  }

  // Prefer real same-host hrefs / non-root paths (generic — not product route names).
  if (href && /^https?:\/\//i.test(href)) score += 2;
  try {
    if (href) {
      const path = new URL(href, 'http://explore.invalid').pathname;
      const segments = path.split('/').filter(Boolean);
      if (segments.length >= 1) score += 2;
      if (segments.length >= 2) score += 1;
    }
  } catch {
    /* ignore */
  }

  // Mild preference for short nav labels (menus / tabs / chips) over long body CTAs.
  if (labelL.length > 0 && labelL.length <= 24) score += 1;
  if (labelL.length > 48) score -= 2;

  return score;
}

/**
 * View fingerprint for visited tracking.
 * Includes hash so `#section` ≠ base path; optional cue/click keys for same-URL SPA views.
 */
export function exploreViewKey(input: {
  url: string;
  cuesSummary?: string;
  clickLabel?: string;
}): string {
  const urlKey = (normalizeExploreUrl(input.url, undefined, { keepHash: true }) || input.url).toLowerCase();
  const click = (input.clickLabel || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
  if (click) return `${urlKey}|click:${click}`;
  const cues = (input.cuesSummary || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160);
  return cues ? `${urlKey}|cues:${cues}` : urlKey;
}

/** True when two cue summaries look like a meaningful SPA view change (heading/region). */
export function cuesMeaningfullyChanged(before?: string, after?: string): boolean {
  const a = (before || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const b = (after || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!b) return false;
  if (!a) return true;
  if (a === b) return false;
  const headingA = /heading\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(a)?.[1]?.toLowerCase() || '';
  const headingB = /heading\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(b)?.[1]?.toLowerCase() || '';
  if (headingA && headingB && headingA !== headingB) return true;
  // Distinct enough when cue blob differs substantially (filters, tabs, drawers, …).
  if (a.slice(0, 120) !== b.slice(0, 120)) return true;
  return a !== b;
}

export function collectCrawlTargets(input: {
  links?: Array<{ label: string; href?: string }>;
  buttons?: string[];
  candidateUrls?: string[];
  pageUrl: string;
  depth: number;
  keywords: CrawlKeywords;
  /** Visited view keys from {@link exploreViewKey} (hash-aware). */
  visited: Set<string>;
}): CrawlTarget[] {
  const out: CrawlTarget[] = [];
  const seenKey = new Set<string>();

  const push = (kind: CrawlTargetKind, label: string, href?: string) => {
    const cleaned = (label || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!cleaned && !href) return;
    if (isDestructiveNavLabel(cleaned)) return;
    if (isSkippableHref(href)) return;

    let abs: string | undefined;
    let hashNav = false;
    if (href) {
      abs = resolveExploreHref(href, input.pageUrl);
      if (!abs) return;
      if (!sameExploreHost(input.pageUrl, abs)) return;
      hashNav = isHashOnlyNavigation(input.pageUrl, abs);
      // Skip only when this exact URL+hash was already captured as a landing/view (not cue variants).
      const urlOnly = (normalizeExploreUrl(abs, undefined, { keepHash: true }) || abs).toLowerCase();
      if (input.visited.has(urlOnly)) return;
    }

    const key = `${kind}|${cleaned.toLowerCase()}|${(abs || '').toLowerCase()}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);

    const score = scoreCrawlTarget(cleaned, abs, input.keywords);
    if (score < 0) return;
    out.push({
      kind,
      label: cleaned || abs || 'link',
      href: abs,
      score,
      depth: input.depth,
      hashNav,
    });
  };

  for (const link of input.links ?? []) {
    push('link', link.label || link.href || '', link.href);
  }
  for (const btn of input.buttons ?? []) {
    push('button', btn);
  }
  for (const url of input.candidateUrls ?? []) {
    push('route', `route ${url}`, url);
  }

  return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * Playwright MCP `browser_evaluate` body: discover links (text+href) and
 * button/tab/menuitem labels + disabled state. Self-contained — runs in the page.
 */
export const CRAWL_LINK_DISCOVERY_SCRIPT = `() => {
  const textOf = (el) => {
    const raw = (el && (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '')) + '';
    return raw.replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
  const isDisabled = (el) => {
    if (!el) return false;
    if (el.disabled === true) return true;
    const aria = (el.getAttribute && el.getAttribute('aria-disabled')) || '';
    if (String(aria).toLowerCase() === 'true') return true;
    if (el.classList && (el.classList.contains('disabled') || el.classList.contains('is-disabled'))) return true;
    return false;
  };
  const links = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('a[href], [role="link"][href], nav a[href]'))) {
    if (links.length >= 40) break;
    const href = a.href || a.getAttribute('href') || '';
    const label = textOf(a) || href;
    const key = (href + '|' + label).toLowerCase();
    if (!href || href === '#' || seen.has(key)) continue;
    seen.add(key);
    links.push({ label, href, disabled: isDisabled(a) });
  }
  const buttons = [];
  const disabled = [];
  const clickable = 'button,[role="button"],[role="tab"],[role="menuitem"],[role="option"],input[type="button"],input[type="submit"]';
  for (const el of Array.from(document.querySelectorAll(clickable))) {
    if (buttons.length + disabled.length >= 50) break;
    const label = textOf(el) || (el.value || '');
    if (!label) continue;
    if (isDisabled(el)) {
      if (!disabled.includes(label)) disabled.push(label);
    } else if (!buttons.includes(label)) {
      buttons.push(label);
    }
  }
  return { url: location.href || '', links, buttons, disabled };
}`;

export interface CrawlDiscoveryResult {
  url: string;
  links: Array<{ label: string; href?: string; disabled?: boolean }>;
  buttons: string[];
  /** Enabled=false controls observed on the page (do not click until enabled). */
  disabled: string[];
}

export function parseCrawlDiscovery(raw: string): CrawlDiscoveryResult | undefined {
  const text = (raw || '').trim();
  if (!text) return undefined;
  try {
    // Prefer last JSON object (evaluate may wrap noise).
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      url?: string;
      links?: Array<{ label?: string; href?: string; text?: string; disabled?: boolean }>;
      buttons?: string[] | Array<{ label?: string; disabled?: boolean }>;
      disabled?: string[];
    };
    const links = (parsed.links ?? [])
      .map((l) => ({
        label: String(l.label || l.text || l.href || '').trim(),
        href: l.href ? String(l.href) : undefined,
        disabled: Boolean(l.disabled),
      }))
      .filter((l) => l.label || l.href);
    const buttons: string[] = [];
    const disabled = [...(parsed.disabled ?? []).map((d) => String(d).trim()).filter(Boolean)];
    for (const b of parsed.buttons ?? []) {
      if (typeof b === 'string') {
        if (b.trim()) buttons.push(b.trim());
        continue;
      }
      const label = String(b.label || '').trim();
      if (!label) continue;
      if (b.disabled) disabled.push(label);
      else buttons.push(label);
    }
    return {
      url: String(parsed.url || ''),
      links,
      buttons: [...new Set(buttons)],
      disabled: [...new Set(disabled)],
    };
  } catch {
    return undefined;
  }
}

export function headingFromCues(cuesSummary?: string): string | undefined {
  if (!cuesSummary) return undefined;
  return /heading\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(cuesSummary)?.[1]?.replace(/\\"/g, '"').trim()
    || undefined;
}

/** Build a compact before→after change line for Explore MD findings. */
export function summarizeClickChange(input: {
  urlBefore: string;
  urlAfter: string;
  cuesBefore?: string;
  cuesAfter?: string;
  disabledBefore?: string[];
  disabledAfter?: string[];
}): { changed: boolean; changeSummary: string; newlyEnabled: string[] } {
  const parts: string[] = [];
  const urlBefore = normalizeExploreUrl(input.urlBefore, undefined, { keepHash: true }) || input.urlBefore;
  const urlAfter = normalizeExploreUrl(input.urlAfter, undefined, { keepHash: true }) || input.urlAfter;
  if (urlBefore.toLowerCase() !== urlAfter.toLowerCase()) {
    parts.push(`URL ${urlBefore} → ${urlAfter}`);
  } else {
    parts.push(`URL unchanged (${urlAfter})`);
  }
  const hBefore = headingFromCues(input.cuesBefore);
  const hAfter = headingFromCues(input.cuesAfter);
  if (hBefore || hAfter) {
    if ((hBefore || '') !== (hAfter || '')) {
      parts.push(`heading "${hBefore || '(none)'}" → "${hAfter || '(none)'}"`);
    } else if (hAfter) {
      parts.push(`heading stayed "${hAfter}"`);
    }
  }
  const cueChanged = cuesMeaningfullyChanged(input.cuesBefore, input.cuesAfter);
  if (cueChanged) {
    parts.push('cues/region changed');
  } else if (urlBefore.toLowerCase() === urlAfter.toLowerCase()) {
    parts.push('visible catalog/cues looked the same');
  }
  const beforeDis = new Set((input.disabledBefore ?? []).map((d) => d.toLowerCase()));
  const afterDis = new Set((input.disabledAfter ?? []).map((d) => d.toLowerCase()));
  const newlyEnabled = (input.disabledBefore ?? []).filter((d) => !afterDis.has(d.toLowerCase()));
  const newlyDisabled = (input.disabledAfter ?? []).filter((d) => !beforeDis.has(d.toLowerCase()));
  if (newlyEnabled.length) parts.push(`newly enabled: ${newlyEnabled.slice(0, 6).join(', ')}`);
  if (newlyDisabled.length) parts.push(`newly disabled: ${newlyDisabled.slice(0, 6).join(', ')}`);
  if ((input.disabledAfter ?? []).length && !newlyEnabled.length && !newlyDisabled.length) {
    parts.push(`disabled: ${(input.disabledAfter ?? []).slice(0, 6).join(', ')}`);
  }
  const changed = urlBefore.toLowerCase() !== urlAfter.toLowerCase() || cueChanged || newlyEnabled.length > 0;
  return { changed, changeSummary: parts.join('; '), newlyEnabled };
}

/** Format click outcomes for the findings string / planner. */
export function formatClickFindings(outcomes: Array<{
  control: string;
  kind: string;
  changeSummary: string;
  result: string;
  disabledBefore?: string[];
  newlyEnabled?: string[];
}>): string {
  if (outcomes.length === 0) return '';
  const lines = ['Click findings:'];
  for (const o of outcomes) {
    lines.push(`- Clicked ${o.kind} "${o.control}" → ${o.changeSummary} [${o.result}]`);
    if (o.disabledBefore?.length) {
      lines.push(`  disabled before: ${o.disabledBefore.slice(0, 8).join(', ')}`);
    }
    if (o.newlyEnabled?.length) {
      lines.push(`  became enabled: ${o.newlyEnabled.slice(0, 8).join(', ')}`);
    }
  }
  return lines.join('\n');
}

/** Operator-facing one-liner for multi-page explore progress. */
export function formatExplorePageProgress(urls: string[]): string {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return 'Explored 0 pages';
  if (unique.length === 1) return `Explored 1 page: ${unique[0]}`;
  return `Explored ${unique.length} pages: ${unique.join(', ')}`;
}
