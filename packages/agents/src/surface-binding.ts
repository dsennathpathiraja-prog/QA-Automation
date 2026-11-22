/**
 * Story → surface binding: derive expected surface kind / candidate routes and
 * a primary validation URL when known (Phase 8 E1).
 */

import {
  analyzeWorkItemStory,
  isNotificationTemplateStory,
  type StoryAnalysis,
} from './story-scenarios';
import type { SurfaceKind } from './types';

export type { SurfaceKind };

/** Marker embedded in Playwright source / case summary for execute-time Blocked. */
export const NEEDS_SURFACE_TAG = 'needs-surface';
export const NEEDS_SURFACE_MARKER = `@qa-platform:${NEEDS_SURFACE_TAG}`;

export interface SurfaceBinding {
  surfaceKind: SurfaceKind;
  /** Absolute primary validation URL when known from WI or a matching explore hit. */
  primarySurfaceUrl?: string;
  /** Relative path candidates to try beyond the environment app root. */
  candidateRoutes: string[];
  /** Absolute candidate URLs composed from environment base + routes (and WI URLs). */
  candidateUrls: string[];
  analysis: StoryAnalysis;
}

const TEMPLATE_ROUTES = [
  '/email',
  '/notification',
  '/notifications',
  '/template',
  '/templates',
  '/preview',
  '/email-preview',
  '/admin/email-templates',
  '/admin/notifications',
];

const SHOP_ROUTES = ['/shop', '/cart', '/checkout', '/order'];

export function extractStoryUrls(blob: string): string[] {
  const hits = [...blob.matchAll(/\bhttps?:\/\/[^\s)\]"'<>]+/gi)].map((m) => m[0].replace(/[),.;]+$/, ''));
  const out: string[] = [];
  for (const u of hits) {
    if (!out.some((x) => x.toLowerCase() === u.toLowerCase())) out.push(u);
  }
  return out.slice(0, 8);
}

export function inferSurfaceKind(analysis: StoryAnalysis, storyBlob = ''): SurfaceKind {
  if (analysis.notificationTemplate || isNotificationTemplateStory(storyBlob)) return 'template';
  const blob = `${analysis.surfaces.join(' ')} ${storyBlob}`.toLowerCase();
  if (/\/shop\b|host app simulator|add to cart|catalog|checkout|cart\b/.test(blob)
    && !/notification|email.?template|escrow notification/i.test(blob)) {
    return 'shop';
  }
  if (/shop|checkout|cart|order placement/i.test(analysis.surfaces.join(' '))
    && !analysis.notificationTemplate) {
    return 'shop';
  }
  return 'other';
}

export function candidateRoutesForKind(kind: SurfaceKind): string[] {
  if (kind === 'template') return [...TEMPLATE_ROUTES];
  if (kind === 'shop') return [...SHOP_ROUTES];
  return [];
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

function joinOriginPath(origin: string, path: string): string {
  const base = origin.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

/** Prefer template/email-ish URLs from the WI when choosing a primary. */
function pickPrimaryFromStoryUrls(urls: string[], kind: SurfaceKind): string | undefined {
  if (urls.length === 0) return undefined;
  if (kind === 'template') {
    const match = urls.find((u) => /email|notif|template|preview|mail/i.test(u));
    if (match) return match;
    // Explicit WI URL that is not clearly a shop catalog can still bind.
    const nonShop = urls.find((u) => !/\/shop\b|\/cart\b|\/checkout\b/i.test(u));
    return nonShop;
  }
  return urls[0];
}

/**
 * Bind expected surface kind + candidate routes/URLs from WI analysis and optional env base.
 * `primarySurfaceUrl` is set only when known from the story (absolute URL) — explore may
 * later promote a matched candidate to primary when the live page matches the kind.
 */
export function bindStorySurface(input: {
  story: string;
  criteria?: string[];
  workItemTitle?: string;
  application?: string;
  /** Environment application URL (app root / shop host). */
  environmentUrl?: string;
  analysis?: StoryAnalysis;
}): SurfaceBinding {
  const analysis = input.analysis ?? analyzeWorkItemStory({
    story: input.story,
    criteria: input.criteria,
    workItemTitle: input.workItemTitle,
    application: input.application,
  });
  const blob = [input.workItemTitle, input.story, ...(input.criteria ?? [])].filter(Boolean).join('\n');
  const surfaceKind = inferSurfaceKind(analysis, blob);
  const storyUrls = extractStoryUrls(blob);
  const routes = candidateRoutesForKind(surfaceKind);
  const origin = input.environmentUrl ? originOf(input.environmentUrl) : undefined;
  const composed = origin
    ? routes.map((r) => joinOriginPath(origin, r))
    : [];
  const candidateUrls = [...storyUrls, ...composed].filter((u, i, arr) => (
    arr.findIndex((x) => x.toLowerCase() === u.toLowerCase()) === i
  )).slice(0, 12);

  return {
    surfaceKind,
    primarySurfaceUrl: pickPrimaryFromStoryUrls(storyUrls, surfaceKind),
    candidateRoutes: routes,
    candidateUrls,
    analysis,
  };
}

/** True when a live explore URL/title/cues match the expected template surface. */
export function exploredSurfaceMatchesKind(
  kind: SurfaceKind,
  cues: { url?: string; title?: string; headings?: string[]; buttons?: string[]; fields?: string[] },
): boolean {
  const blob = [
    cues.url,
    cues.title,
    ...(cues.headings ?? []),
    ...(cues.buttons ?? []),
    ...(cues.fields ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (!blob) return false;
  if (kind === 'template') {
    return /template|email|notif|preview|greeting|paid amount|subject|escrow notification/i.test(blob);
  }
  if (kind === 'shop') {
    return /\/shop\b|host app simulator|add to cart|all items|order summary|cart|products/i.test(blob);
  }
  return true;
}

/** Promote primary URL after explore when a matching surface was reached. */
export function resolvePrimarySurfaceUrl(binding: SurfaceBinding, exploredUrls: string[]): string | undefined {
  if (binding.primarySurfaceUrl) return binding.primarySurfaceUrl;
  for (const url of exploredUrls) {
    if (exploredSurfaceMatchesKind(binding.surfaceKind, { url })) return url;
  }
  return undefined;
}

export function isNeedsSurfaceCase(input: {
  tags?: string[];
  steps?: string;
  summary?: string;
  expected?: string;
}): boolean {
  if (input.tags?.includes(NEEDS_SURFACE_TAG)) return true;
  const blob = [input.steps, input.summary, input.expected].filter(Boolean).join('\n');
  return blob.includes(NEEDS_SURFACE_MARKER) || /\bneeds-surface\b/i.test(blob);
}

/** Playwright body that fails closed (Blocked/Skipped) without asserting on the wrong surface. */
export function buildNeedsSurfacePlaywrightSource(input: {
  name: string;
  gapMessage: string;
  primarySurfaceUrl?: string;
  surfaceKind?: SurfaceKind;
}): string {
  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const detail = [
    input.gapMessage,
    input.surfaceKind ? `Expected surface kind: ${input.surfaceKind}.` : '',
    input.primarySurfaceUrl ? `Primary validation URL (when available): ${input.primarySurfaceUrl}.` : 'No primary template/preview URL was bound.',
  ].filter(Boolean).join(' ');
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `// ${NEEDS_SURFACE_MARKER} Blocked — explore surface gap`,
    `test('${esc(input.name)}', async () => {`,
    `  test.skip(true, '${esc(detail.slice(0, 280))}');`,
    '});',
    '',
  ].join('\n');
}
