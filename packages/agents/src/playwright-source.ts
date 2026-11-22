/**
 * Scenario-first Playwright source: parse explore cues, emit real actions/assertions,
 * and reject body-only stubs. Also assesses whether explore coverage matches the WI.
 */

import { buildNeedsSurfacePlaywrightSource } from './surface-binding';
import type { PlannerScenario, ScenarioKind, ScenarioPriority, SurfaceKind } from './types';

export interface ExplorationCues {
  url: string;
  title: string;
  headings: string[];
  buttons: string[];
  links: string[];
  fields: string[];
  raw: string;
}

export type ExploreCoverageKind = 'strong' | 'secondary' | 'weak' | 'none';

export interface ExploreCoverage {
  kind: ExploreCoverageKind;
  /** Near-duplicate explore rows (same URL + similar cues across AC labels). */
  duplicateSurfaces: boolean;
  /** Distinct absolute/relative URLs seen in findings. */
  urls: string[];
  /** Explored surface looks like a shop/catalog host simulator. */
  shopSurface: boolean;
  /** Work item / criteria look like email/notification template content. */
  templateWorkItem: boolean;
  /**
   * Fail-closed: explored surface does not match the story (e.g. shop-only for email WI).
   * Cases must not Pass assertions against the wrong surface.
   */
  blockingGap: boolean;
  surfaceKind: SurfaceKind;
  primarySurfaceUrl?: string;
  /** Human warning for the plan artifact / Done line. */
  warning: string;
  cues: ExplorationCues;
}

const clip = (value: string, max: number) => value.trim().slice(0, max);

const uniq = (values: string[]): string[] => {
  const out: string[] = [];
  for (const v of values) {
    const t = v.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
};

/** Pull quoted labels from `buttons="A","B"` / `heading="X"` style findings lines. */
function quotedLabels(chunk: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    const v = m[1]!.replace(/\\"/g, '"').trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * Parse UI/code exploration findings into URLs and control labels the generator can use.
 * Tolerates compact findings lines such as:
 * `- Explore: … @ http://host/shop (Title) title="…"; heading="…"; buttons="A","B"`
 */
export function parseExplorationCues(findings?: string): ExplorationCues {
  const raw = (findings ?? '').trim();
  const empty: ExplorationCues = { url: '', title: '', headings: [], buttons: [], links: [], fields: [], raw };
  if (!raw) return empty;

  const url = (
    /\bhttps?:\/\/[^\s)\]"'<>]+/i.exec(raw)?.[0]
    || /(?:^|\n)\s*-\s*[^\n]*?@\s*(https?:\/\/\S+)/i.exec(raw)?.[1]
    || /(?:^|\s)(\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/i.exec(raw)?.[1]
    || ''
  ).replace(/[),.;]+$/, '');

  const title = /title\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(raw)?.[1]?.replace(/\\"/g, '"').trim()
    || /\(([^()\n]{3,80})\)/.exec(raw)?.[1]?.trim()
    || '';

  const section = (label: string): string[] => {
    const hit = new RegExp(`${label}\\s*=\\s*([^;\\n]+)`, 'i').exec(raw)?.[1] ?? '';
    return quotedLabels(hit);
  };

  const headingSingle = /heading\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(raw)?.[1]?.replace(/\\"/g, '"').trim();

  return {
    url,
    title,
    headings: uniq([...section('headings?'), ...(headingSingle ? [headingSingle] : [])]),
    buttons: uniq(section('buttons?')),
    links: uniq(section('links?')),
    fields: uniq(section('fields?')),
    raw,
  };
}

/** Fingerprint one explore row for duplicate detection (URL + cue signature). */
function exploreRowFingerprint(block: string): string {
  const url = (/\bhttps?:\/\/[^\s)\]"'<>]+/i.exec(block)?.[0] || '').replace(/[),.;]+$/, '').toLowerCase();
  const cueSig = [
    /title\s*=\s*"([^"]*)"/i.exec(block)?.[1],
    /heading\s*=\s*"([^"]*)"/i.exec(block)?.[1],
    /buttons\s*=\s*([^;\n]+)/i.exec(block)?.[1],
    /fields\s*=\s*([^;\n]+)/i.exec(block)?.[1],
  ].map((v) => (v || '').toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
  return `${url}::${cueSig}`;
}

/**
 * True when multiple Explore rows share the same URL + near-identical cues
 * (e.g. every AC label landed on the same shop catalog snapshot).
 */
export function hasNearDuplicateExploreFindings(findings?: string): boolean {
  const raw = (findings ?? '').trim();
  if (!raw) return false;
  const rows = raw.split(/\n(?=-\s)/).map((r) => r.trim()).filter((r) => /@\s*https?:\/\//i.test(r) || /Explore:/i.test(r));
  if (rows.length < 2) {
    // Also treat repeated identical URL mentions as duplicates when labeled differently.
    const urls = [...raw.matchAll(/\bhttps?:\/\/[^\s)\]"'<>]+/gi)].map((m) => m[0].replace(/[),.;]+$/, '').toLowerCase());
    const unique = new Set(urls);
    return urls.length >= 3 && unique.size === 1;
  }
  const fingerprints = rows.map(exploreRowFingerprint).filter((f) => f !== '::');
  if (fingerprints.length < 2) return false;
  const unique = new Set(fingerprints);
  // Majority share one fingerprint → not distinct UI surfaces.
  const counts = new Map<string, number>();
  for (const f of fingerprints) counts.set(f, (counts.get(f) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return unique.size === 1 || max >= Math.ceil(fingerprints.length * 0.75);
}

export function looksLikeShopSurface(cues: ExplorationCues, findings?: string): boolean {
  const blob = `${cues.url} ${cues.title} ${cues.headings.join(' ')} ${cues.buttons.join(' ')} ${cues.links.join(' ')} ${findings || ''}`.toLowerCase();
  return /\/shop\b|host app simulator|add to cart|all items|order summary|cart|kitchen|travel|products/i.test(blob);
}

export function looksLikeTemplateWorkItem(storyOrCriteria: string): boolean {
  return /notification|email|template|greeting|main message|order details summary|paid amount|escrow notification/i.test(storyOrCriteria);
}

/**
 * Assess whether exploration findings are strong enough for scenario-distinct UI paths.
 * Duplicate shop snapshots against a template WI → weak/secondary (order-flow only).
 */
export function assessExplorationCoverage(input: {
  findings?: string;
  story?: string;
  criteria?: string[];
}): ExploreCoverage {
  const cues = parseExplorationCues(input.findings);
  const storyBlob = [input.story, ...(input.criteria ?? [])].filter(Boolean).join('\n');
  const urls = uniq([
    ...[...(input.findings || '').matchAll(/\bhttps?:\/\/[^\s)\]"'<>]+/gi)].map((m) => m[0].replace(/[),.;]+$/, '')),
    ...(cues.url ? [cues.url] : []),
  ]);
  const templateWorkItem = looksLikeTemplateWorkItem(storyBlob);
  const surfaceKind: SurfaceKind = templateWorkItem ? 'template' : looksLikeShopSurface(cues, input.findings) ? 'shop' : 'other';
  const findingsGap = /Explore (?:UI )?gap:|blocking explore gap|needs-surface|escrow notification email template \/ preview was not found/i
    .test(input.findings || '');

  if (!input.findings?.trim() || (!cues.url && cues.buttons.length === 0 && cues.headings.length === 0)) {
    return {
      kind: 'none',
      duplicateSurfaces: false,
      urls,
      shopSurface: false,
      templateWorkItem,
      blockingGap: templateWorkItem || findingsGap,
      surfaceKind,
      warning: templateWorkItem
        ? 'Blocking explore gap: no usable notification/template surface was explored — cases must not Pass against an unknown host.'
        : 'No usable UI exploration — scenarios are grounded in the work item description/AC only.',
      cues,
    };
  }
  const duplicateSurfaces = hasNearDuplicateExploreFindings(input.findings);
  const shopSurface = looksLikeShopSurface(cues, input.findings);
  const surfaceMatchesTemplate = /template|email|notif|preview|greeting|paid amount/i.test(
    `${cues.url} ${cues.title} ${cues.headings.join(' ')} ${cues.fields.join(' ')} ${cues.buttons.join(' ')}`,
  );

  if (templateWorkItem && shopSurface && !surfaceMatchesTemplate) {
    const warning = duplicateSurfaces
      ? 'Blocking explore gap: repeated identical shop/catalog snapshots across AC labels — not the notification/template surface. Do not treat catalog as email-field coverage; mark template scenarios needs-surface / Blocked.'
      : 'Blocking explore gap: Explore UI reached a shop/catalog surface, but the work item is a notification/email template. Do not Pass email-field assertions against the catalog; mark those scenarios needs-surface / Blocked.';
    return {
      kind: 'secondary',
      duplicateSurfaces,
      urls,
      shopSurface,
      templateWorkItem,
      blockingGap: true,
      surfaceKind: 'template',
      primarySurfaceUrl: undefined,
      warning,
      cues,
    };
  }

  if (duplicateSurfaces) {
    return {
      kind: 'weak',
      duplicateSurfaces: true,
      urls,
      shopSurface,
      templateWorkItem,
      blockingGap: templateWorkItem || findingsGap,
      surfaceKind,
      warning: 'Weak Explore UI: near-duplicate URL/snapshots across different AC targets — do not invent distinct UI scenarios from these findings; prioritize work item description/AC.',
      cues,
    };
  }

  return {
    kind: 'strong',
    duplicateSurfaces: false,
    urls,
    shopSurface,
    templateWorkItem,
    blockingGap: false,
    surfaceKind: surfaceMatchesTemplate ? 'template' : shopSurface ? 'shop' : surfaceKind,
    primarySurfaceUrl: cues.url || undefined,
    warning: '',
    cues,
  };
}

/** True when a planned scenario asserts email/notification template content (not shop order trigger). */
export function isTemplateSurfaceScenario(scenario: PlannerScenario): boolean {
  const blob = `${scenario.name} ${scenario.criterion} ${scenario.steps} ${scenario.expected}`;
  if (/order.?placement|checkout|cart|trigger only|payment COMPLETED|order Placed|do not send before/i.test(blob)
    && !/subject|greeting|Paid Amount|Confirm Delivery|support@|placeholder|main message|order details table/i.test(blob)) {
    return false;
  }
  return /escrow|notification|greeting|paid amount|confirm delivery|subject|placeholder|email template|order details|support@|held in escrow|Customer Name/i.test(blob);
}

/** Whether explore cues may drive distinct per-control UI scenario seeds. */
export function exploreSupportsDistinctUiScenarios(coverage: ExploreCoverage): boolean {
  return coverage.kind === 'strong' && !coverage.duplicateSurfaces;
}

/**
 * True when the Playwright source is a near-empty stub: sole meaningful assertion is
 * `expect(page.locator('body')).toBeVisible()` (or equivalent), with no real interactions.
 */
export function isStubPlaywrightSource(source: string): boolean {
  const src = source ?? '';
  if (!src.trim()) return true;
  const bodyAssert = /expect\s*\(\s*page\.locator\(\s*['"]body['"]\s*\)\s*\)\s*\.toBeVisible\s*\(/.test(src);
  if (!bodyAssert) return false;
  const hasRoleOrLabel = /page\.getBy(Role|Label|Text|Placeholder|TestId|AltText|Title)\s*\(/.test(src);
  const hasNonBodyLocator = /page\.locator\(\s*['"](?!body['"])[^'"]+['"]/.test(src);
  const hasInteraction = /\.(click|fill|type|press|check|uncheck|selectOption|setInputFiles)\s*\(/.test(src);
  return !(hasRoleOrLabel || hasNonBodyLocator || hasInteraction);
}

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function pick<T>(items: T[], index: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.abs(index) % items.length];
}

function keywordTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !/^(with|from|that|this|when|then|should|must|have|been|into|over|under|after|before|order|amount|placement)$/.test(w));
}

function assertionText(scenario: PlannerScenario): string {
  const fromExpected = clip(scenario.expected.replace(/\s+/g, ' '), 80);
  if (fromExpected && !/succeeds with the expected|criterion still holds|refused with a clear/i.test(fromExpected)) {
    return fromExpected;
  }
  const focus = clip(scenario.criterion.replace(/\s+/g, ' '), 60);
  return focus || scenario.name;
}

/**
 * Build a distinct Playwright `.spec.js` body for one planned scenario.
 * Uses explore cues only when the surface matches (or as secondary shop→order flow).
 * Never emits body-visibility as the sole assertion; never fakes template-field UI on a catalog page.
 * When explore is a blocking surface gap, template scenarios fail closed (needs-surface skip).
 */
export function buildMeaningfulPlaywrightSource(input: {
  scenario: PlannerScenario;
  application: string;
  findings?: string;
  story?: string;
  criteria?: string[];
  index?: number;
}): string {
  const { scenario, application } = input;
  const index = input.index ?? 0;
  const coverage = assessExplorationCoverage({
    findings: input.findings,
    story: input.story || `${scenario.criterion}\n${scenario.name}`,
    criteria: input.criteria,
  });
  const cues = coverage.cues;
  const targetUrl = cues.url || '/';
  const name = esc(scenario.name);
  const templateScenario = isTemplateSurfaceScenario(scenario);
  const weakShop = coverage.kind === 'secondary' || (coverage.shopSurface && coverage.templateWorkItem);
  // Fail closed: do not assert email fields against shop catalog when surface is mismatched.
  if (coverage.blockingGap && templateScenario) {
    return buildNeedsSurfacePlaywrightSource({
      name: scenario.name,
      gapMessage: coverage.warning
        || 'Explore did not reach the notification/template surface; case is Blocked (needs-surface).',
      primarySurfaceUrl: coverage.primarySurfaceUrl,
      surfaceKind: coverage.surfaceKind,
    });
  }
  // Story-grounded template cases: do not invent shop-catalog clicks from weak explore.
  const storyTemplatePath = templateScenario && (weakShop || coverage.kind !== 'strong');
  const useUiSelectors = coverage.kind === 'strong' && !storyTemplatePath;

  const heading = useUiSelectors ? (pick(cues.headings, index) || cues.title) : '';
  const field = useUiSelectors ? pick(cues.fields, index) : undefined;
  const button = useUiSelectors ? pick(cues.buttons, index) : undefined;
  const link = useUiSelectors ? pick(cues.links, index) : undefined;

  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test('${name}', async ({ page }) => {`,
    `  await page.goto('${esc(storyTemplatePath ? '/' : targetUrl)}');`,
    `  // ${scenario.kind} (${scenario.priority}): ${clip(scenario.criterion.replace(/\s+/g, ' '), 160)}`,
    `  // Steps: ${clip(scenario.steps.replace(/\s+/g, ' '), 220)}`,
  ];
  if (coverage.warning) {
    lines.push(`  // Explore coverage (${coverage.kind}): ${clip(coverage.warning.replace(/\s+/g, ' '), 220)}`);
  }

  if (storyTemplatePath) {
    return appendStoryTemplateAssertions(lines, scenario);
  }

  if (heading) {
    lines.push(`  await expect(page.getByRole('heading', { name: '${esc(heading)}' })).toBeVisible();`);
  } else if (cues.title && useUiSelectors) {
    lines.push(`  await expect(page).toHaveTitle(/${escapeRegExp(cues.title).slice(0, 60)}/i);`);
  } else {
    lines.push(`  await expect(page.getByRole('main').or(page.locator('h1, h2, [role="main"]')).first()).toBeVisible();`);
  }

  const kind = scenario.kind;
  const tokens = keywordTokens(`${scenario.criterion} ${scenario.name} ${scenario.expected}`);
  const primaryToken = tokens[0] || clip(focusWord(scenario), 24) || application;
  const assertNeedle = assertionText(scenario);

  if (kind === 'negative') {
    if (field) {
      lines.push(`  await page.getByLabel('${esc(field)}').fill('__INVALID__');`);
      lines.push(`  await expect(page.getByText(/invalid|error|required|not allowed|rejected/i).first()).toBeVisible();`);
    } else if (button) {
      lines.push(`  await page.getByRole('button', { name: '${esc(button)}' }).click();`);
      lines.push(`  await expect(page.getByText(/invalid|error|required|blocked|denied|rejected/i).first()).toBeVisible();`);
    } else {
      lines.push(`  // Negative path grounded in WI/AC (explore did not expose a matching control)`);
      lines.push(`  await expect(page.getByText(/${escapeRegExp(primaryToken)}|error|invalid|required/i).first()).toBeVisible();`);
    }
  } else if (kind === 'edge') {
    if (field) {
      const edgeValue = /zero|empty|minimum/i.test(scenario.name) ? '' : /maximum|max|long/i.test(scenario.name) ? '9'.repeat(12) : '0.01';
      lines.push(edgeValue === ''
        ? `  await page.getByLabel('${esc(field)}').fill('');`
        : `  await page.getByLabel('${esc(field)}').fill('${esc(edgeValue)}');`);
      if (button) lines.push(`  await page.getByRole('button', { name: '${esc(button)}' }).click();`);
      lines.push(`  await expect(page.getByText(/${escapeRegExp(clip(assertNeedle, 40))}|${escapeRegExp(primaryToken)}/i).first()).toBeVisible();`);
    } else if (button) {
      lines.push(`  await page.getByRole('button', { name: '${esc(button)}' }).click();`);
      lines.push(`  await expect(page.getByText(/${escapeRegExp(primaryToken)}/i).first()).toBeVisible();`);
    } else if (link) {
      lines.push(`  await page.getByRole('link', { name: '${esc(link)}' }).click();`);
      lines.push(`  await expect(page.getByText(/${escapeRegExp(primaryToken)}/i).first()).toBeVisible();`);
    } else {
      lines.push(`  await expect(page.getByText(/${escapeRegExp(primaryToken)}/i).first()).toBeVisible();`);
    }
  } else if (field) {
    lines.push(`  await page.getByLabel('${esc(field)}').fill('42.00');`);
    if (button) lines.push(`  await page.getByRole('button', { name: '${esc(button)}' }).click();`);
    else if (link) lines.push(`  await page.getByRole('link', { name: '${esc(link)}' }).click();`);
    lines.push(`  await expect(page.getByText(/${escapeRegExp(clip(assertNeedle, 48))}|${escapeRegExp(primaryToken)}/i).first()).toBeVisible();`);
  } else {
    if (button) lines.push(`  await page.getByRole('button', { name: '${esc(button)}' }).click();`);
    else if (link) lines.push(`  await page.getByRole('link', { name: '${esc(link)}' }).click();`);
    lines.push(`  await expect(page.getByText(/${escapeRegExp(clip(assertNeedle, 48))}|${escapeRegExp(primaryToken)}/i).first()).toBeVisible();`);
  }

  lines.push('});', '');
  return lines.join('\n');
}

/** Story-grounded escrow/notification assertions — never fake shop-catalog email-field explores. */
function appendStoryTemplateAssertions(lines: string[], scenario: PlannerScenario): string {
  const blob = `${scenario.name} ${scenario.criterion} ${scenario.steps} ${scenario.expected}`;
  lines.push(`  // Story-grounded notification/template scenario (explore did not reach email UI)`);
  lines.push(`  await expect(page.getByRole('main').or(page.locator('h1, h2, [role="main"]')).first()).toBeVisible();`);

  if (/subject|held in escrow/i.test(blob)) {
    lines.push(`  await expect(page.getByText(/held in escrow/i).first()).toBeVisible();`);
  } else if (/greeting|customer name/i.test(blob)) {
    if (scenario.kind === 'negative') {
      lines.push(`  await expect(page.getByText(/\\[Customer Name\\]/).first()).toHaveCount(0);`);
    } else {
      lines.push(`  await expect(page.getByText(/^Hi\\b/i).first()).toBeVisible();`);
    }
  } else if (/confirm delivery/i.test(blob)) {
    lines.push(`  await expect(page.getByRole('link', { name: /Confirm Delivery/i }).or(page.getByRole('button', { name: /Confirm Delivery/i })).first()).toBeVisible();`);
  } else if (/paid amount|order details|table/i.test(blob)) {
    lines.push(`  await expect(page.getByText(/Paid Amount|Order ID|Merchant/i).first()).toBeVisible();`);
  } else if (/support@|footer|copyright/i.test(blob)) {
    lines.push(`  await expect(page.getByText(/support@paynsure\\.com|PayNSure Escrow/i).first()).toBeVisible();`);
  } else if (/COMPLETED|Placed|trigger|send/i.test(blob)) {
    if (scenario.kind === 'negative') {
      lines.push(`  await expect(page.getByText(/held in escrow|Confirm Delivery/i).first()).toHaveCount(0);`);
    } else {
      lines.push(`  await expect(page.getByText(/COMPLETED|Placed|held in escrow/i).first()).toBeVisible();`);
    }
  } else if (/bracket|placeholder|\[Customer Name\]|\[Paid Amount\]/i.test(blob)) {
    lines.push(`  await expect(page.getByText(/\\[(Customer Name|Order ID|Merchant|Paid Amount)\\]/)).toHaveCount(0);`);
  } else {
    lines.push(`  await expect(page.getByText(/escrow|Order ID|Paid Amount|Confirm Delivery/i).first()).toBeVisible();`);
  }

  lines.push('});', '');
  return lines.join('\n');
}

function focusWord(scenario: PlannerScenario): string {
  const cleaned = scenario.criterion
    .replace(/^(given|when|then|and)\b/gi, '')
    .replace(/\b(the|a|an|user|shopper|system|should|must|can|will)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(/\s+/).find((w) => w.length >= 4) || cleaned || 'result';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "\\'");
}

/** Prefer model/heuristic source when it is not a stub; otherwise rebuild from the scenario. */
export function ensureMeaningfulPlaywrightSource(input: {
  source: string;
  scenario: PlannerScenario;
  application: string;
  findings?: string;
  story?: string;
  criteria?: string[];
  index?: number;
}): string {
  if (!isStubPlaywrightSource(input.source) && input.source.includes('@playwright/test')) {
    return input.source;
  }
  return buildMeaningfulPlaywrightSource({
    scenario: input.scenario,
    application: input.application,
    findings: input.findings,
    story: input.story,
    criteria: input.criteria,
    index: input.index,
  });
}

export type { ScenarioKind, ScenarioPriority };
