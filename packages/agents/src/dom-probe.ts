/**
 * DOM probe used when Playwright MCP accessibility snapshots are empty
 * (SPA still hydrating, iframe shell, or aria tree blank while Chrome shows UI).
 * Runs via `browser.evaluate` / `browser_evaluate`.
 */

import type { ParsedPageSnapshot, SnapshotCues } from './snapshot-content';
import { snapshotCuesFromYaml } from './snapshot-content';

/** JSON shape returned by {@link DOM_PROBE_SCRIPT}. */
export interface DomProbeResult {
  url: string;
  title: string;
  readyState: string;
  bodyText: string;
  headings: string[];
  buttons: string[];
  links: string[];
  fields: string[];
  iframes: Array<{ src: string; name: string; title: string; width: number; height: number }>;
  frameDocs: Array<{
    src: string;
    title: string;
    buttons: string[];
    links: string[];
    fields: string[];
    text: string;
  }>;
  loadError?: string;
}

/**
 * Function body for Playwright MCP `browser_evaluate`.
 * Must be a self-contained `() => { … }` string (runs in the page).
 */
export const DOM_PROBE_SCRIPT = `() => {
  const textOf = (el) => {
    const raw = (el && (el.innerText || el.textContent || el.value || '')) + '';
    return raw.replace(/\\s+/g, ' ').trim().slice(0, 120);
  };
  const names = (nodes, limit = 40) => {
    const out = [];
    for (const el of nodes) {
      if (out.length >= limit) break;
      const n = textOf(el)
        || (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('alt') || ''))
        || (el.value || '');
      const cleaned = (n || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    }
    return out;
  };
  const collect = (root) => {
    if (!root) return { headings: [], buttons: [], links: [], fields: [], text: '' };
    const q = (sel) => Array.from(root.querySelectorAll(sel));
    return {
      headings: names(q('h1,h2,h3,h4,[role="heading"]'), 24),
      buttons: names(q('button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]'), 40),
      links: names(q('a[href],[role="link"]'), 40),
      fields: names(q('input:not([type="hidden"]),textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"]'), 40),
      text: textOf(root.body || root).slice(0, 2000),
    };
  };
  const href = location.href || '';
  let loadError;
  if (/^chrome-error:\\/\\//i.test(href) || /^chrome:\\/\\//i.test(href)) {
    loadError = 'browser_error_page';
  }
  const bodyText = textOf(document.body || document.documentElement);
  if (/ERR_NAME_NOT_RESOLVED|DNS_PROBE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_HTTP_RESPONSE_CODE_FAILURE|This site (can.t|cannot) be reached|took too long to respond/i.test(bodyText)) {
    loadError = loadError || 'navigation_failed';
  }
  const main = collect(document);
  const iframes = Array.from(document.querySelectorAll('iframe')).slice(0, 12).map((f) => ({
    src: f.src || '',
    name: f.name || '',
    title: f.title || '',
    width: f.offsetWidth || 0,
    height: f.offsetHeight || 0,
  }));
  const frameDocs = [];
  for (const f of Array.from(document.querySelectorAll('iframe')).slice(0, 8)) {
    try {
      const doc = f.contentDocument;
      if (!doc) continue;
      const inner = collect(doc);
      frameDocs.push({
        src: f.src || '',
        title: doc.title || '',
        buttons: inner.buttons,
        links: inner.links,
        fields: inner.fields,
        text: inner.text.slice(0, 800),
      });
    } catch {
      /* cross-origin — listed in iframes only */
    }
  }
  return {
    url: href,
    title: document.title || '',
    readyState: document.readyState || '',
    bodyText: main.text,
    headings: main.headings,
    buttons: main.buttons,
    links: main.links,
    fields: main.fields,
    iframes,
    frameDocs,
    loadError,
  };
}`;

/** Shop / SPA cues Explore waits for before declaring the page empty. */
export const EXPLORE_SETTLE_TEXTS = [
  'Add to cart',
  'Proceed to checkout',
  'Order summary',
  'Search products',
  'Metro Mobile',
  'Checkout',
  'PayNSure',
] as const;

const uniq = (values: string[], limit = 40): string[] => {
  const out: string[] = [];
  for (const v of values) {
    const t = (v || '').replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
};

/** Merge main-document + same-origin iframe controls into one cue set. */
export function mergeDomProbeCues(probe: DomProbeResult): SnapshotCues {
  const headings = [...probe.headings];
  const buttons = [...probe.buttons];
  const links = [...probe.links];
  const fields = [...probe.fields];
  for (const frame of probe.frameDocs) {
    if (frame.title && (frame.buttons.length || frame.links.length || frame.fields.length)) {
      headings.push(frame.title);
    }
    buttons.push(...frame.buttons);
    links.push(...frame.links);
    fields.push(...frame.fields);
  }
  return {
    headings: uniq(headings, 24),
    buttons: uniq(buttons),
    links: uniq(links),
    fields: uniq(fields),
  };
}

/** Build planner-facing YAML from a DOM probe (when aria snapshot is blank). */
export function yamlFromDomProbe(probe: DomProbeResult): string {
  const cues = mergeDomProbeCues(probe);
  const lines: string[] = ['- document:'];
  const pushRole = (role: string, name: string) => {
    const safe = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`  - ${role} "${safe}"`);
  };
  for (const h of cues.headings.slice(0, 12)) pushRole('heading', h);
  for (const b of cues.buttons.slice(0, 20)) pushRole('button', b);
  for (const l of cues.links.slice(0, 20)) pushRole('link', l);
  for (const f of cues.fields.slice(0, 16)) pushRole('textbox', f);
  for (const frame of probe.iframes.slice(0, 8)) {
    const label = frame.title || frame.name || frame.src || 'iframe';
    const safe = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`  - iframe "${safe}"`);
  }
  if (probe.bodyText && lines.length <= 2) {
    const snippet = probe.bodyText.slice(0, 240).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`  - text "${snippet}"`);
  }
  return lines.join('\n');
}

/** True when the probe found interactive / visible storefront content. */
export function domProbeIsActionable(probe: DomProbeResult | undefined): boolean {
  if (!probe) return false;
  if (probe.loadError) return false;
  if (/^about:blank$/i.test(probe.url) || /^chrome-error:\/\//i.test(probe.url)) return false;
  const cues = mergeDomProbeCues(probe);
  if (cues.buttons.length + cues.links.length + cues.fields.length + cues.headings.length > 0) return true;
  if ((probe.bodyText || '').trim().length >= 40) return true;
  for (const frame of probe.frameDocs) {
    if ((frame.text || '').trim().length >= 40) return true;
  }
  return false;
}

/** Convert a DOM probe into the same ParsedPageSnapshot shape as MCP aria text. */
export function parsedSnapshotFromDomProbe(probe: DomProbeResult): ParsedPageSnapshot {
  const cues = mergeDomProbeCues(probe);
  const yaml = yamlFromDomProbe(probe);
  const raw = [
    '### Page state',
    `- Page URL: ${probe.url}`,
    `- Page Title: ${probe.title}`,
    '- Page Snapshot:',
    '```yaml',
    yaml,
    '```',
    probe.bodyText ? `\n### Visible text\n${probe.bodyText.slice(0, 1_500)}` : '',
  ].filter(Boolean).join('\n');
  return {
    raw,
    url: probe.url,
    title: probe.title,
    yaml,
    cues: cues.headings.length || cues.buttons.length || cues.links.length || cues.fields.length
      ? cues
      : snapshotCuesFromYaml(yaml),
  };
}

/**
 * Pull JSON from MCP `browser_evaluate` tool text (`### Result` then JSON,
 * often followed by `### Ran Playwright code` / `### Page state`).
 */
export function parseEvaluateToolResult(toolText: string): DomProbeResult | undefined {
  const text = (toolText ?? '').trim();
  if (!text) return undefined;
  const afterResult = /###\s*Result\s*\r?\n([\s\S]*)$/i.exec(text)?.[1] ?? text;
  const jsonChunk = afterResult.split(/\r?\n###\s+/)[0]?.trim() ?? '';
  const candidates = [jsonChunk, text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as DomProbeResult;
      if (parsed && typeof parsed === 'object' && ('url' in parsed || 'buttons' in parsed || 'bodyText' in parsed)) {
        return {
          url: String(parsed.url ?? ''),
          title: String(parsed.title ?? ''),
          readyState: String(parsed.readyState ?? ''),
          bodyText: String(parsed.bodyText ?? ''),
          headings: Array.isArray(parsed.headings) ? parsed.headings.map(String) : [],
          buttons: Array.isArray(parsed.buttons) ? parsed.buttons.map(String) : [],
          links: Array.isArray(parsed.links) ? parsed.links.map(String) : [],
          fields: Array.isArray(parsed.fields) ? parsed.fields.map(String) : [],
          iframes: Array.isArray(parsed.iframes) ? parsed.iframes as DomProbeResult['iframes'] : [],
          frameDocs: Array.isArray(parsed.frameDocs) ? parsed.frameDocs as DomProbeResult['frameDocs'] : [],
          loadError: parsed.loadError ? String(parsed.loadError) : undefined,
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  return undefined;
}

const NAV_DNS_OR_NET =
  /ERR_NAME_NOT_RESOLVED|DNS_PROBE_FINISHED_NXDOMAIN|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|This site (can.t|cannot) be reached|took too long to respond/i;
const NAV_HTTP_STATUS =
  /ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_HTTP_RESPONSE_CODE_FAILURE|HTTP (4\d\d|5\d\d)\b/i;

/** True when Chromium got an HTTP 4xx/5xx (DNS worked; often wrong extra_hosts IP / VirtualHost). */
export function isHttpResponseCodeFailure(text: string | undefined): boolean {
  return !!text && NAV_HTTP_STATUS.test(text);
}

/** True when navigate/snapshot/probe landed on Chromium's DNS/network/HTTP-error page. */
export function isBrowserNavigationFailure(input: {
  url?: string;
  rawSnapshot?: string;
  probe?: DomProbeResult;
}): boolean {
  const pageUrl = input.probe?.url || input.url || '';
  const raw = `${input.rawSnapshot || ''}\n${input.probe?.bodyText || ''}`;
  if (input.probe?.loadError) return true;
  if (/^chrome-error:\/\//i.test(pageUrl) || /^chrome:\/\//i.test(pageUrl)) return true;
  if (isHttpResponseCodeFailure(raw)) return true;
  return NAV_DNS_OR_NET.test(raw);
}

/** Operator-facing DNS / extra_hosts guidance (set PLAYWRIGHT_MCP_SHOP_IP to the real LAN IP). */
export function dnsExtraHostsGuidance(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch { /* keep raw */ }
  return (
    `Chromium inside Playwright MCP did not load ${url} (DNS/network error page). ` +
    `Host Chrome can resolve ${host}, but the playwright-mcp container does not inherit host /etc/hosts. ` +
    `Set PLAYWRIGHT_MCP_SHOP_IP to the shop LAN IP, apply the playwright-shop compose overlay, ` +
    `recreate playwright-mcp, run \`deploy/compose/scripts/verify-playwright-shop-dns.sh\`, then retry Explore UI`
  );
}

/**
 * DNS worked but Chromium rejected the HTTP status (4xx/5xx).
 * Common when extra_hosts points sdk.paynsure.internal at host-gateway / wrong machine.
 */
export function httpResponseFailureGuidance(url: string, detail?: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch { /* keep raw */ }
  const hint = detail ? detail.replace(/\s+/g, ' ').trim().slice(0, 160) : 'ERR_HTTP_RESPONSE_CODE_FAILURE';
  return (
    `Chromium reached ${url} but the HTTP response was an error status (${hint}). ` +
    `DNS worked — ${host} is probably mapped to the wrong IP (host-gateway hitting Docker Desktop / a non-shop listener). ` +
    `Set PLAYWRIGHT_MCP_SHOP_IP to the host DNS / LAN IP that serves the shop VirtualHost, ` +
    `recreate playwright-mcp with the shop-hosts overlay, confirm verify-playwright-shop-dns.sh prints HTTP 2xx, then retry Explore UI`
  );
}

/** Pick DNS vs HTTP-status guidance from Chromium / probe text. */
export function navigationFailureGuidance(url: string, raw?: string): string {
  if (isHttpResponseCodeFailure(raw)) return httpResponseFailureGuidance(url, raw);
  return dnsExtraHostsGuidance(url);
}

/** Human reason when capture failed after retries (blank vs iframe vs DNS vs probe denied). */
export function describeEmptyCapture(input: {
  url: string;
  title?: string;
  rawSnapshot?: string;
  probe?: DomProbeResult;
  probeError?: string;
}): string {
  const probe = input.probe;
  const raw = input.rawSnapshot || '';
  if (isBrowserNavigationFailure({ url: probe?.url || input.url, rawSnapshot: raw, probe })) {
    return navigationFailureGuidance(input.url, `${raw}\n${input.probeError || ''}`);
  }
  if (input.probeError) {
    if (isHttpResponseCodeFailure(input.probeError)) {
      return httpResponseFailureGuidance(input.url, input.probeError);
    }
    if (/circuit breaker/i.test(input.probeError)) {
      return (
        `DOM probe blocked (${input.probeError}). ` +
        'Re-run Playwright → Test connection (Success closes the circuit), confirm browser.evaluate is granted, Switch the connector on, then retry Explore UI'
      );
    }
    if (/already in use|mcp-chromium|use --isolated/i.test(input.probeError)) {
      return (
        `DOM probe blocked by a locked Chromium profile (${input.probeError.replace(/\s+/g, ' ').slice(0, 160)}). ` +
        'Rebuild playwright-mcp with --isolated (QA-43), recreate the browser container, rebuild worker if needed (durable-pool-qa43), Test connection, then retry'
      );
    }
    if (/No open pages?|No open tabs|mcp-session-id|lost the tab|durable-pool|session was not found/i.test(input.probeError)) {
      return (
        `DOM probe found no open browser page after navigate (${input.probeError.replace(/\s+/g, ' ').slice(0, 180)}). ` +
        'Rebuild worker + playwright-mcp with --build from foundation (must include durable-pool-qa43), restart both, Test connection, then retry Explore UI'
      );
    }
    return (
      `DOM probe failed (${input.probeError}). ` +
      'Explore UI needs browser.evaluate on the Playwright connector — re-run Test connection after upgrading, confirm browser.evaluate is supported, then retry'
    );
  }
  const iframeCount = probe?.iframes?.length ?? (/\biframe\b/i.test(raw) ? 1 : 0);
  if (iframeCount > 0 && !domProbeIsActionable(probe)) {
    const srcs = (probe?.iframes ?? []).map((f) => f.src).filter(Boolean).slice(0, 3).join(', ');
    return (
      `page shell has ${iframeCount} iframe${iframeCount === 1 ? '' : 's'}` +
      (srcs ? ` (${srcs})` : '') +
      ' but no extractable same-origin controls — payment/SDK content may be cross-origin opaque to the accessibility tree'
    );
  }
  if (input.title) {
    return `page title "${input.title}" but no accessibility tree / interactive cues after settle waits and DOM probe`;
  }
  if (probe && (probe.bodyText || '').trim().length === 0 && probe.readyState === 'complete') {
    return 'document ready but body text empty (blank render in headless Chromium — check viewport, CSP, or app gating)';
  }
  if (!probe && !input.probeError) {
    return (
      'empty accessibility snapshot and DOM probe did not run (browser.evaluate missing on the connector). ' +
      'Re-run Playwright Test connection so browser.wait / browser.evaluate are granted, then retry Explore UI'
    );
  }
  return 'empty accessibility snapshot and DOM probe found no buttons/links/fields (page blank, still loading, or MCP returned no content)';
}
