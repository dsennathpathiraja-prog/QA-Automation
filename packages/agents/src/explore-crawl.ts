/**
 * Bounded multi-page UI explore crawl helpers.
 * Discovers in-app links/buttons, ranks by story relevance, skips destructive actions.
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
  /** Absolute href when known (links / candidate routes). */
  href?: string;
  score: number;
  depth: number;
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

/** Non-navigational / external schemes. */
const SKIP_HREF = /^(mailto:|tel:|sms:|javascript:|data:|#)/i;

const NAV_HINT = /\b(nav|menu|home|cart|checkout|shop|catalog|order|account|settings|profile|dashboard|template|email|preview|notification|product|category|help|about|search)\b/i;

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

export function normalizeExploreUrl(url: string, base?: string): string | undefined {
  try {
    const u = base ? new URL(url, base) : new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    // Drop trailing slash for fingerprinting (keep root as `/`).
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

export function isDestructiveNavLabel(label: string): boolean {
  return DESTRUCTIVE_LABEL.test((label || '').trim());
}

export function isSkippableHref(href: string | undefined): boolean {
  if (!href) return false;
  const t = href.trim();
  if (!t || t === '#' || SKIP_HREF.test(t)) return true;
  return false;
}

/** Score a click/nav target higher when it matches AC / story terms / nav hints. */
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

  let score = 1;
  if (NAV_HINT.test(blob)) score += 4;

  const terms = [
    ...keywords.terms,
    ...keywords.criteria.flatMap((c) => c.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)),
    ...keywords.surfaces,
  ].map((t) => t.toLowerCase().trim()).filter(Boolean);

  for (const term of [...new Set(terms)].slice(0, 40)) {
    if (term.length < 3) continue;
    if (blob.includes(term)) score += term.length >= 6 ? 6 : 3;
  }

  // Prefer path-ish hrefs over empty/#.
  if (href && /^https?:\/\//i.test(href)) score += 2;
  if (href && /\/(cart|checkout|shop|order|email|template|preview|notif)/i.test(href)) score += 5;

  // Mild preference for short nav labels (menus) over long body CTAs.
  if (labelL.length > 0 && labelL.length <= 24) score += 1;
  if (labelL.length > 48) score -= 2;

  return score;
}

export function collectCrawlTargets(input: {
  links?: Array<{ label: string; href?: string }>;
  buttons?: string[];
  candidateUrls?: string[];
  pageUrl: string;
  depth: number;
  keywords: CrawlKeywords;
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
    if (href) {
      abs = normalizeExploreUrl(href, input.pageUrl);
      if (!abs) return;
      if (!sameExploreHost(input.pageUrl, abs)) return;
      const fp = abs.toLowerCase();
      if (input.visited.has(fp)) return;
    }

    const key = `${kind}|${cleaned.toLowerCase()}|${(abs || '').toLowerCase()}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);

    const score = scoreCrawlTarget(cleaned, abs, input.keywords);
    if (score < 0) return;
    out.push({ kind, label: cleaned || abs || 'link', href: abs, score, depth: input.depth });
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
 * Playwright MCP `browser_evaluate` body: discover links (text+href) and button labels
 * for story-scoped crawl. Self-contained — runs in the page.
 */
export const CRAWL_LINK_DISCOVERY_SCRIPT = `() => {
  const textOf = (el) => {
    const raw = (el && (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '')) + '';
    return raw.replace(/\\s+/g, ' ').trim().slice(0, 80);
  };
  const links = [];
  const seen = new Set();
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    if (links.length >= 40) break;
    const href = a.href || a.getAttribute('href') || '';
    const label = textOf(a) || href;
    const key = (href + '|' + label).toLowerCase();
    if (!href || seen.has(key)) continue;
    seen.add(key);
    links.push({ label, href });
  }
  const buttons = [];
  for (const el of Array.from(document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]'))) {
    if (buttons.length >= 30) break;
    const label = textOf(el) || (el.value || '');
    if (label && !buttons.includes(label)) buttons.push(label);
  }
  return { url: location.href || '', links, buttons };
}`;

export interface CrawlDiscoveryResult {
  url: string;
  links: Array<{ label: string; href?: string }>;
  buttons: string[];
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
      links?: Array<{ label?: string; href?: string; text?: string }>;
      buttons?: string[];
    };
    const links = (parsed.links ?? [])
      .map((l) => ({
        label: String(l.label || l.text || l.href || '').trim(),
        href: l.href ? String(l.href) : undefined,
      }))
      .filter((l) => l.label || l.href);
    const buttons = (parsed.buttons ?? []).map((b) => String(b).trim()).filter(Boolean);
    return { url: String(parsed.url || ''), links, buttons };
  } catch {
    return undefined;
  }
}

/** Operator-facing one-liner for multi-page explore progress. */
export function formatExplorePageProgress(urls: string[]): string {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return 'Explored 0 pages';
  if (unique.length === 1) return `Explored 1 page: ${unique[0]}`;
  return `Explored ${unique.length} pages: ${unique.join(', ')}`;
}
