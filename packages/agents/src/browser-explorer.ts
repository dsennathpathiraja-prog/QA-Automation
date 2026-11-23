import { PlatformError } from '@qa/domain';
import {
  DOM_PROBE_SCRIPT,
  describeEmptyCapture,
  domProbeIsActionable,
  isBrowserNavigationFailure,
  isHttpResponseCodeFailure,
  navigationFailureGuidance,
  parseEvaluateToolResult,
  parsedSnapshotFromDomProbe,
  type DomProbeResult,
} from './dom-probe';
import {
  CRAWL_LINK_DISCOVERY_SCRIPT,
  collectCrawlTargets,
  createCrawlBounds,
  crawlBudgetOpen,
  cuesMeaningfullyChanged,
  exploreViewKey,
  formatClickFindings,
  formatExplorePageProgress,
  headingFromCues,
  isHashOnlyNavigation,
  normalizeExploreUrl,
  parseCrawlDiscovery,
  resolveExploreHref,
  sameExploreHost,
  summarizeClickChange,
  type CrawlKeywords,
  type CrawlTarget,
} from './explore-crawl';
import {
  parseMcpPageSnapshot,
  snapshotArtifactBody,
  snapshotIsActionable,
  summarizeSnapshotForFindings,
} from './snapshot-content';
import { analyzeWorkItemStory, isNotificationTemplateStory } from './story-scenarios';
import {
  bindStorySurface,
  exploredSurfaceMatchesKind,
  resolvePrimarySurfaceUrl,
} from './surface-binding';
import { hasNearDuplicateExploreFindings, looksLikeShopSurface, parseExplorationCues } from './playwright-source';
import type {
  BrowserAutomationPort,
  BrowserExplorerPort,
  ExploreClickOutcome,
  ExploreFinding,
  ExploreRequest,
  ExploreResult,
} from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Captured = {
  parsed: ReturnType<typeof parseMcpPageSnapshot>;
  accessibilityTree: string;
  probe?: DomProbeResult;
  probeError?: string;
};

/**
 * Time-based SPA settle only. Do not call MCP `browser_wait_for` with `text` here:
 * @playwright/mcp@0.0.35 has no timeout arg, so missing copy can block ~30s per attempt.
 */
async function settleForStorefront(browser: BrowserAutomationPort, seconds = 2): Promise<void> {
  if (!browser.waitFor) {
    await sleep(Math.round(seconds * 1000));
    return;
  }
  await browser.waitFor({ timeSeconds: seconds }).catch(() => undefined);
}

async function probeDom(
  browser: BrowserAutomationPort,
  opts?: { reNavigateUrl?: string },
): Promise<{ probe?: DomProbeResult; error?: string }> {
  const evaluate = browser.evaluate;
  if (!evaluate) {
    return { error: 'browser.evaluate is not available on this browser port' };
  }
  const run = async () => {
    const out = await evaluate({ script: DOM_PROBE_SCRIPT });
    const fromResult = parseEvaluateToolResult(out.resultText || '');
    if (fromResult) return { probe: fromResult };
    const fromTree = parseEvaluateToolResult(out.accessibilityTree || out.resultText || '');
    if (fromTree) return { probe: fromTree };
    const raw = `${out.resultText || ''}\n${out.accessibilityTree || ''}`;
    if (/No open pages?/i.test(raw) || /No open tabs/i.test(raw)) {
      return { error: raw.trim() || 'No open pages available' };
    }
    return { error: 'browser.evaluate returned no parseable DOM probe JSON' };
  };
  const lostPage = (msg: string) => /No open pages?/i.test(msg) || /No open tabs/i.test(msg) || /lost the tab/i.test(msg);
  try {
    const first = await run();
    if (!first.error || !lostPage(first.error) || !opts?.reNavigateUrl) {
      return first;
    }
    // Session lost the tab — navigate again on the same platform sessionId, then probe once more.
    await browser.navigate(opts.reNavigateUrl);
    await settleForStorefront(browser, 2);
    return await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'evaluate failed';
    if (lostPage(msg) && opts?.reNavigateUrl) {
      try {
        await browser.navigate(opts.reNavigateUrl);
        await settleForStorefront(browser, 2);
        return await run();
      } catch (e2) {
        return { error: e2 instanceof Error ? e2.message : msg };
      }
    }
    return { error: msg };
  }
}

function throwIfNavigationFailed(input: {
  targetUrl: string;
  pageUrl?: string;
  raw?: string;
  probe?: DomProbeResult;
}): void {
  if (!isBrowserNavigationFailure({ url: input.pageUrl || input.targetUrl, rawSnapshot: input.raw, probe: input.probe })) {
    return;
  }
  const raw = `${input.raw || ''}\n${input.probe?.bodyText || ''}\n${input.probe?.loadError || ''}\n${input.pageUrl || ''}`;
  throw new PlatformError('transient', navigationFailureGuidance(input.targetUrl, raw));
}

/**
 * Capture a snapshot useful for planning: SPA settle, aria retries, then DOM/iframe
 * evaluate when the accessibility tree is empty (shell / iframe apps).
 */
async function captureActionableSnapshot(
  browser: BrowserAutomationPort,
  fallbackUrl: string,
  targetUrl: string,
  priorProbe?: { probe?: DomProbeResult; error?: string },
): Promise<Captured> {
  const attempts = 4;
  let lastRaw = '';
  let lastUrl = fallbackUrl;
  let lastTitle = '';
  let lastProbe: DomProbeResult | undefined = priorProbe?.probe;
  let lastProbeError: string | undefined = priorProbe?.error;
  let probedOnce = Boolean(priorProbe?.probe || priorProbe?.error);

  await settleForStorefront(browser, 2.5);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await settleForStorefront(browser, Math.min(4, 1.5 + attempt));
    }

    try {
      const snap = await browser.snapshot();
      lastRaw = snap.accessibilityTree ?? '';
      lastUrl = snap.url || fallbackUrl;
      lastTitle = snap.title ?? '';
    } catch {
      // Provider may throw on a truly empty MCP payload; retry after wait.
    }

    throwIfNavigationFailed({ targetUrl, pageUrl: lastUrl, raw: lastRaw, probe: lastProbe });

    const parsed = parseMcpPageSnapshot(lastRaw);
    if (!parsed.url && lastUrl) parsed.url = lastUrl;
    if (!parsed.title && lastTitle) parsed.title = lastTitle;
    if (snapshotIsActionable(parsed)) {
      return { parsed, accessibilityTree: snapshotArtifactBody(parsed) || lastRaw };
    }

    // Probe DOM at most once per capture — repeated evaluate failures used to open the circuit breaker.
    if (!probedOnce) {
      const probed = await probeDom(browser, { reNavigateUrl: targetUrl });
      probedOnce = true;
      lastProbe = probed.probe;
      if (probed.error) lastProbeError = probed.error;
    }
    throwIfNavigationFailed({ targetUrl, pageUrl: lastProbe?.url || lastUrl, raw: lastRaw, probe: lastProbe });
    if (domProbeIsActionable(lastProbe)) {
      const fromDom = parsedSnapshotFromDomProbe(lastProbe!);
      return { parsed: fromDom, accessibilityTree: snapshotArtifactBody(fromDom), probe: lastProbe };
    }

    // Click a likely storefront control once if DOM probe found cart/checkout copy.
    if (attempt === 1 && browser.interact && lastProbe) {
      const clickTarget = lastProbe.buttons.find((b) => /add to cart|checkout|buy|pay|cart/i.test(b));
      if (clickTarget) {
        await browser.interact({ action: 'click', target: clickTarget }).catch(() => undefined);
        await settleForStorefront(browser, 1.5);
      }
    }
  }

  if (domProbeIsActionable(lastProbe)) {
    const fromDom = parsedSnapshotFromDomProbe(lastProbe!);
    return { parsed: fromDom, accessibilityTree: snapshotArtifactBody(fromDom), probe: lastProbe };
  }

  throwIfNavigationFailed({ targetUrl, pageUrl: lastProbe?.url || lastUrl, raw: lastRaw, probe: lastProbe });

  const parsed = parseMcpPageSnapshot(lastRaw);
  if (!parsed.url && lastUrl) parsed.url = lastUrl;
  if (!parsed.title && lastTitle) parsed.title = lastTitle;
  return {
    parsed,
    accessibilityTree: snapshotArtifactBody(parsed) || lastRaw,
    probe: lastProbe,
    probeError: lastProbeError,
  };
}

/**
 * In-repo explorer that drives the managed Playwright MCP connector
 * (same role as Cursor's playwright-browser MCP). Runs BEFORE the planner so
 * findings can feed the Markdown test plan. App-agnostic: starts at the WI /
 * environment URL (any allowlisted host), then bounded-crawls in-app
 * links/buttons/tabs. Failures throw — Explore UI must succeed with a real
 * session + navigate + non-empty snapshot before planning.
 */
export function createBrowserExplorer(browser: BrowserAutomationPort | undefined): BrowserExplorerPort {
  return {
    async explore(input: ExploreRequest): Promise<ExploreResult> {
      if (!input.url) {
        throw new PlatformError(
          'validation',
          input.environment
            ? `Explore UI needs an openable application URL for environment "${input.environment}". Check the environment's application URL and the browser allowlist.`
            : 'Explore UI needs an environment on the run so Playwright can open the application URL before planning.',
        );
      }
      if (!browser) {
        throw new PlatformError(
          'denied',
          `Explore UI needs a bound Playwright browser connector to open ${input.url} before planning.`,
        );
      }

      const analysis = analyzeWorkItemStory({
        story: input.story || '',
        criteria: input.criteria,
        workItemTitle: input.workItemTitle,
        application: input.application,
      });
      const binding = bindStorySurface({
        story: input.story || '',
        criteria: input.criteria,
        workItemTitle: input.workItemTitle,
        application: input.application,
        environmentUrl: input.url,
        templatePreviewUrl: input.templatePreviewUrl,
        analysis,
      });
      const templateStory = analysis.notificationTemplate
        || isNotificationTemplateStory(input.story || '', input.criteria ?? [])
        || binding.surfaceKind === 'template';
      // Story-driven primary label; additional pages come from bounded link/button crawl.
      const primaryLabel = input.scenarios[0]?.name
        || (templateStory
          ? (binding.primarySurfaceUrl
            ? 'Explore: escrow notification template / email preview (configured)'
            : 'Explore: escrow notification template / email preview')
          : `Explore: ${(input.criteria?.[0] || input.application)}`);
      const details: ExploreFinding[] = [];
      const probes: Array<DomProbeResult | undefined> = [];
      const probeErrors: Array<string | undefined> = [];
      // Prefer WI / configured template preview primary; otherwise the environment app root.
      const startUrl = binding.primarySurfaceUrl || input.url;
      const bounds = createCrawlBounds({
        maxPages: input.maxPages ?? (templateStory ? 3 : 5),
        maxDepth: input.maxDepth ?? (templateStory ? 1 : 2),
        maxMs: input.maxCrawlMs,
      });
      // Template stories keep a tighter page cap so shop crawl does not drown email evidence.
      const pageCap = templateStory ? Math.min(bounds.maxPages, 3) : bounds.maxPages;
      const crawlKeywords: CrawlKeywords = {
        terms: analysis.searchTerms,
        criteria: input.criteria ?? [],
        surfaces: analysis.surfaces,
      };

      const pushFinding = (
        finding: ExploreFinding,
        probe?: DomProbeResult,
        probeError?: string,
      ) => {
        details.push(finding);
        probes.push(probe);
        probeErrors.push(probeError);
      };

      // Hash-aware view keys so `#section` routes and same-URL SPA views are distinct.
      const visited = new Set<string>();
      const discoveryDone = new Set<string>();
      const clickOutcomes: ExploreClickOutcome[] = [];
      const markVisited = (url: string, opts?: { cuesSummary?: string; clickLabel?: string }) => {
        const urlOnly = normalizeExploreUrl(url, undefined, { keepHash: true });
        if (urlOnly) visited.add(urlOnly.toLowerCase());
        visited.add(exploreViewKey({ url, cuesSummary: opts?.cuesSummary, clickLabel: opts?.clickLabel }));
      };

      try {
        await browser.openSession();
        let nav: Awaited<ReturnType<BrowserAutomationPort['navigate']>>;
        try {
          nav = await browser.navigate(startUrl);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (isHttpResponseCodeFailure(msg) || /ERR_NAME_NOT_RESOLVED|DNS_PROBE|chrome-error/i.test(msg)) {
            // Fall back to environment root when a bound primary URL is unreachable.
            if (startUrl !== input.url) {
              try {
                nav = await browser.navigate(input.url);
              } catch (e2) {
                const msg2 = e2 instanceof Error ? e2.message : String(e2);
                if (isHttpResponseCodeFailure(msg2) || /ERR_NAME_NOT_RESOLVED|DNS_PROBE|chrome-error/i.test(msg2)) {
                  throw new PlatformError('transient', navigationFailureGuidance(input.url, msg2), undefined, e2);
                }
                throw e2;
              }
            } else {
              throw new PlatformError('transient', navigationFailureGuidance(input.url, msg), undefined, e);
            }
          } else {
            throw e;
          }
        }

        // Fail fast on chrome-error / DNS / HTTP status before spending retries on empty aria trees.
        throwIfNavigationFailed({
          targetUrl: startUrl,
          pageUrl: nav.finalUrl,
          raw: nav.accessibilityTree,
        });

        let earlyProbe: { probe?: DomProbeResult; error?: string } | undefined;
        let currentUrl = nav.finalUrl || startUrl;

        // Prefer a snapshot already attached to navigate when the tree is rich enough.
        if (nav.accessibilityTree) {
          const fromNav = parseMcpPageSnapshot(nav.accessibilityTree);
          if (!fromNav.url) fromNav.url = nav.finalUrl || startUrl;
          if (!fromNav.title && nav.title) fromNav.title = nav.title;
          if (snapshotIsActionable(fromNav)) {
            const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
            const url = fromNav.url || nav.finalUrl || startUrl;
            const cuesSummary = summarizeSnapshotForFindings(fromNav);
            pushFinding({
              scenarioName: primaryLabel,
              url,
              title: fromNav.title || undefined,
              snapshotExcerpt: snapshotArtifactBody(fromNav),
              cuesSummary,
              screenshotBase64: shot.artifactBase64 || undefined,
            });
            markVisited(url, { cuesSummary });
            currentUrl = url;
          }
        }

        // One early DOM probe when navigate aria is empty — reused by capture (no evaluate spam).
        if (details.length === 0 && browser.evaluate) {
          earlyProbe = await probeDom(browser, { reNavigateUrl: startUrl });
          throwIfNavigationFailed({
            targetUrl: startUrl,
            pageUrl: earlyProbe.probe?.url || nav.finalUrl,
            raw: nav.accessibilityTree,
            probe: earlyProbe.probe,
          });
          if (domProbeIsActionable(earlyProbe.probe)) {
            const fromDom = parsedSnapshotFromDomProbe(earlyProbe.probe!);
            const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
            const url = fromDom.url || nav.finalUrl || startUrl;
            const cuesSummary = summarizeSnapshotForFindings(fromDom);
            pushFinding({
              scenarioName: primaryLabel,
              url,
              title: fromDom.title || undefined,
              snapshotExcerpt: snapshotArtifactBody(fromDom),
              cuesSummary,
              screenshotBase64: shot.artifactBase64 || undefined,
            }, earlyProbe.probe);
            markVisited(url, { cuesSummary });
            currentUrl = url;
          }
        }

        if (details.length === 0) {
          const { parsed, accessibilityTree, probe, probeError } = await captureActionableSnapshot(
            browser,
            nav.finalUrl || startUrl,
            startUrl,
            earlyProbe,
          );
          const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
          const url = parsed.url || nav.finalUrl || startUrl;
          const cuesSummary = summarizeSnapshotForFindings(parsed);
          pushFinding({
            scenarioName: primaryLabel,
            url,
            title: parsed.title || undefined,
            snapshotExcerpt: accessibilityTree,
            cuesSummary,
            screenshotBase64: shot.artifactBase64 || undefined,
          }, probe, probeError);
          markVisited(url, { cuesSummary });
          currentUrl = url;
        }

        // Template WI + shop-only root: quick-probe a few candidate routes (no long SPA settle).
        const rootCues = parseExplorationCues(
          details.map((d) => `- ${d.scenarioName} @ ${d.url}\n  ${d.cuesSummary || ''}`).join('\n'),
        );
        if (
          templateStory
          && looksLikeShopSurface(rootCues)
          && !exploredSurfaceMatchesKind('template', rootCues)
          && binding.candidateUrls.length > 0
          && crawlBudgetOpen({ ...bounds, maxPages: pageCap }, details.length)
        ) {
          const toTry = binding.candidateUrls
            .filter((u) => {
              const n = normalizeExploreUrl(u)?.toLowerCase();
              return Boolean(n) && !visited.has(n!);
            })
            .slice(0, 2);
          for (const candidate of toTry) {
            if (!crawlBudgetOpen({ ...bounds, maxPages: pageCap }, details.length)) break;
            try {
              const candNav = await browser.navigate(candidate);
              throwIfNavigationFailed({
                targetUrl: candidate,
                pageUrl: candNav.finalUrl,
                raw: candNav.accessibilityTree,
              });
              let tree = candNav.accessibilityTree || '';
              let pageUrl = candNav.finalUrl || candidate;
              let pageTitle = candNav.title || '';
              if (!snapshotIsActionable(parseMcpPageSnapshot(tree))) {
                const snap = await browser.snapshot().catch(() => undefined);
                if (snap?.accessibilityTree) {
                  tree = snap.accessibilityTree;
                  pageUrl = snap.url || pageUrl;
                  pageTitle = snap.title || pageTitle;
                }
              }
              const parsed = parseMcpPageSnapshot(tree);
              if (!parsed.url) parsed.url = pageUrl;
              if (!parsed.title && pageTitle) parsed.title = pageTitle;
              if (!snapshotIsActionable(parsed)) continue;
              const body = snapshotArtifactBody(parsed) || tree;
              const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
              const url = parsed.url || pageUrl;
              const cuesSummary = summarizeSnapshotForFindings(parsed);
              pushFinding({
                scenarioName: `Explore candidate: ${candidate}`,
                url,
                title: parsed.title || undefined,
                snapshotExcerpt: body,
                cuesSummary,
                screenshotBase64: shot.artifactBase64 || undefined,
              });
              markVisited(url, { cuesSummary });
              currentUrl = url;
              if (exploredSurfaceMatchesKind('template', {
                url,
                title: parsed.title,
                headings: [],
                buttons: [],
                fields: [],
              }) || /template|email|notif|preview|greeting|paid amount/i.test(body)) {
                break;
              }
            } catch {
              // Candidate miss is expected on shop-only hosts — continue; gap recorded below.
            }
          }
        }

        // Multi-page crawl: systematically click in-app links/buttons/tabs within host scope.
        // Restore the frontier page before each click so one hash hop does not strand later filters.
        // Record before→after click findings even when the catalog dump looks similar.
        const landingActionable = details.some((d) => {
          const parsed = parseMcpPageSnapshot(d.snapshotExcerpt);
          if (!parsed.url) parsed.url = d.url;
          if (!parsed.title && d.title) parsed.title = d.title;
          return snapshotIsActionable(parsed);
        });
        const crawlFrontier: Array<{ url: string; depth: number; cuesSummary?: string }> = landingActionable
          ? [{
            url: currentUrl,
            depth: 0,
            cuesSummary: details[details.length - 1]?.cuesSummary,
          }]
          : [];
        const triedTargets = new Set<string>();
        const maxClicks = Math.max(pageCap * 4, 16);
        let clicksDone = 0;
        let landingRetryQueued = false;
        // Disabled controls noted on a page — retry after another click enables them.
        const deferredDisabled = new Map<string, CrawlTarget>();

        const discoverOnPage = async (pageUrl: string, depth: number, cuesSummary?: string): Promise<{
          targets: CrawlTarget[];
          disabled: string[];
        }> => {
          let links: Array<{ label: string; href?: string }> = [];
          let buttons: string[] = [];
          let disabled: string[] = [];
          if (cuesSummary) {
            const cues = parseExplorationCues(`- page @ ${pageUrl}\n  ${cuesSummary}`);
            links = (cues.links || []).map((label) => ({ label }));
            buttons = cues.buttons || [];
          }
          const pageKey = normalizeExploreUrl(pageUrl, undefined, { keepHash: true })?.toLowerCase() || pageUrl.toLowerCase();
          // Re-run discovery when we need fresh disabled/enabled state (keyed per visit attempt via force below).
          if (browser.evaluate) {
            try {
              const out = await browser.evaluate({ script: CRAWL_LINK_DISCOVERY_SCRIPT });
              const discovered = parseCrawlDiscovery(out.resultText || out.accessibilityTree || '');
              if (discovered) {
                discoveryDone.add(pageKey);
                disabled = discovered.disabled;
                if (discovered.links.length) {
                  const byLabel = new Map(
                    discovered.links.map((l) => [l.label.toLowerCase(), l] as const),
                  );
                  links = links.length > 0
                    ? links.map((l) => {
                      const hit = byLabel.get(l.label.toLowerCase());
                      return { ...l, href: l.href || hit?.href };
                    })
                    : discovered.links.map((l) => ({ label: l.label, href: l.href }));
                  for (const extra of discovered.links) {
                    if (!links.some((l) => l.label.toLowerCase() === extra.label.toLowerCase())) {
                      links.push({ label: extra.label, href: extra.href });
                    }
                  }
                }
                for (const b of discovered.buttons) {
                  if (!buttons.some((x) => x.toLowerCase() === b.toLowerCase())) buttons.push(b);
                }
              }
            } catch {
              // Discovery evaluate is best-effort.
            }
          }
          const targets = collectCrawlTargets({
            links: links.filter((l) => !disabled.some((d) => d.toLowerCase() === l.label.toLowerCase())),
            buttons: buttons.filter((b) => !disabled.some((d) => d.toLowerCase() === b.toLowerCase())),
            pageUrl,
            depth,
            keywords: crawlKeywords,
            visited,
          });
          return { targets, disabled };
        };

        const ensureOn = async (url: string): Promise<void> => {
          const want = normalizeExploreUrl(url, undefined, { keepHash: true })?.toLowerCase();
          const have = normalizeExploreUrl(currentUrl, undefined, { keepHash: true })?.toLowerCase();
          if (want && have && want === have) return;
          const back = await browser.navigate(url);
          currentUrl = back.finalUrl || url;
          await settleForStorefront(browser, 1.0);
        };

        while (
          crawlBudgetOpen({ ...bounds, maxPages: Math.max(pageCap, 1) }, 0)
          && clicksDone < maxClicks
          && crawlFrontier.length > 0
        ) {
          // Time budget only for the outer loop (page count gated when capturing).
          if (Date.now() - bounds.startedAt >= bounds.maxMs) break;
          const node = crawlFrontier.shift()!;
          if (node.depth >= bounds.maxDepth) continue;

          try {
            await ensureOn(node.url);
          } catch {
            continue;
          }

          let targets: CrawlTarget[] = [];
          let pageDisabled: string[] = [];
          try {
            const discovered = await discoverOnPage(currentUrl, node.depth + 1, node.cuesSummary);
            targets = discovered.targets;
            pageDisabled = discovered.disabled;
          } catch {
            continue;
          }

          for (const d of pageDisabled) {
            const key = `disabled|${d.toLowerCase()}`;
            if (!triedTargets.has(key) && !deferredDisabled.has(key)) {
              deferredDisabled.set(key, {
                kind: 'button',
                label: d,
                score: 1,
                depth: node.depth + 1,
              });
              clickOutcomes.push({
                control: d,
                kind: 'button',
                urlBefore: currentUrl,
                urlAfter: currentUrl,
                headingBefore: headingFromCues(node.cuesSummary),
                cuesBefore: node.cuesSummary,
                changeSummary: `observed disabled — will retry if enabled later`,
                changed: false,
                disabledBefore: pageDisabled,
                result: 'skipped-disabled',
              });
            }
          }

          // Prefer filters/nav/hash over long CTAs; still try many within click budget.
          const queue = [...targets];
          for (const [key, deferred] of deferredDisabled) {
            if (pageDisabled.some((d) => d.toLowerCase() === deferred.label.toLowerCase())) continue;
            if (!queue.some((t) => t.label.toLowerCase() === deferred.label.toLowerCase())) {
              queue.push(deferred);
            }
            deferredDisabled.delete(key);
          }

          for (const target of queue.slice(0, Math.max(pageCap * 4, 16))) {
            if (clicksDone >= maxClicks) break;
            if (Date.now() - bounds.startedAt >= bounds.maxMs) break;
            const targetKey = `${target.kind}|${target.label.toLowerCase()}|${(target.href || '').toLowerCase()}`;
            if (triedTargets.has(targetKey)) continue;
            triedTargets.add(targetKey);

            // Always return to the frontier page so hash/cart hops do not skip sibling filters.
            try {
              await ensureOn(node.url);
            } catch {
              break;
            }

            const priorCues = node.cuesSummary;
            const urlBefore = currentUrl;
            const disabledBefore = pageDisabled;
            clicksDone += 1;

            try {
              const preferClick = Boolean(browser.interact) && (
                target.kind === 'button'
                || target.hashNav
                || !target.href
                || (target.href ? isHashOnlyNavigation(currentUrl, target.href) : false)
              );

              if (preferClick && browser.interact) {
                await browser.interact({ action: 'click', target: target.label });
                await settleForStorefront(browser, 1.2);
                const after = await browser.snapshot().catch(() => undefined);
                currentUrl = after?.url || currentUrl;
                if (
                  target.href
                  && sameExploreHost(startUrl, target.href)
                  && isHashOnlyNavigation(node.url, target.href)
                ) {
                  const afterNorm = normalizeExploreUrl(currentUrl, undefined, { keepHash: true })?.toLowerCase();
                  const wantNorm = normalizeExploreUrl(target.href, undefined, { keepHash: true })?.toLowerCase();
                  if (wantNorm && afterNorm !== wantNorm) {
                    const hop = await browser.navigate(target.href);
                    currentUrl = hop.finalUrl || target.href;
                  }
                }
              } else if (target.href && sameExploreHost(startUrl, target.href)) {
                const resolved = resolveExploreHref(target.href, currentUrl) || target.href;
                const hop = await browser.navigate(resolved);
                currentUrl = hop.finalUrl || resolved;
              } else if (browser.interact) {
                await browser.interact({ action: 'click', target: target.label });
                await settleForStorefront(browser, 1.2);
                const after = await browser.snapshot().catch(() => undefined);
                currentUrl = after?.url || currentUrl;
              } else {
                continue;
              }

              if (!sameExploreHost(startUrl, currentUrl) && !sameExploreHost(input.url, currentUrl)) {
                clickOutcomes.push({
                  control: target.label,
                  kind: target.kind,
                  urlBefore,
                  urlAfter: currentUrl,
                  changeSummary: 'left allowlisted host — abandoned hop',
                  changed: false,
                  result: 'error',
                });
                await ensureOn(node.url).catch(() => undefined);
                continue;
              }

              const { parsed, accessibilityTree, probe, probeError } = await captureActionableSnapshot(
                browser,
                currentUrl,
                currentUrl,
              );
              const pageUrl = parsed.url || currentUrl;
              const cuesSummary = snapshotIsActionable(parsed) || domProbeIsActionable(probe)
                ? summarizeSnapshotForFindings(parsed)
                : priorCues;
              let disabledAfter: string[] = [];
              if (browser.evaluate) {
                try {
                  const out = await browser.evaluate({ script: CRAWL_LINK_DISCOVERY_SCRIPT });
                  disabledAfter = parseCrawlDiscovery(out.resultText || '')?.disabled ?? [];
                } catch {
                  disabledAfter = [];
                }
              }
              const diff = summarizeClickChange({
                urlBefore,
                urlAfter: pageUrl,
                cuesBefore: priorCues,
                cuesAfter: cuesSummary,
                disabledBefore,
                disabledAfter,
              });
              const urlWithHash = normalizeExploreUrl(pageUrl, undefined, { keepHash: true })?.toLowerCase()
                || pageUrl.toLowerCase();
              const viewKey = exploreViewKey({ url: pageUrl, cuesSummary, clickLabel: target.label });
              const urlChanged = urlWithHash !== (normalizeExploreUrl(node.url, undefined, { keepHash: true })?.toLowerCase() || '');
              const cueChanged = cuesMeaningfullyChanged(priorCues, cuesSummary);
              const shouldCapture = (urlChanged || cueChanged || diff.newlyEnabled.length > 0)
                && !visited.has(viewKey)
                && details.length < pageCap
                && (snapshotIsActionable(parsed) || domProbeIsActionable(probe));

              const outcome: ExploreClickOutcome = {
                control: target.label,
                kind: target.kind,
                urlBefore,
                urlAfter: pageUrl,
                headingBefore: headingFromCues(priorCues),
                headingAfter: headingFromCues(cuesSummary),
                cuesBefore: priorCues,
                cuesAfter: cuesSummary,
                changeSummary: diff.changeSummary,
                changed: diff.changed,
                disabledBefore: disabledBefore.length ? disabledBefore : undefined,
                disabledAfter: disabledAfter.length ? disabledAfter : undefined,
                newlyEnabled: diff.newlyEnabled.length ? diff.newlyEnabled : undefined,
                result: shouldCapture ? 'captured' : (diff.changed ? 'documented' : 'no-op'),
              };
              clickOutcomes.push(outcome);

              // Newly enabled controls become candidates on a follow-up pass of this page.
              for (const label of diff.newlyEnabled) {
                const key = `enabled|${label.toLowerCase()}`;
                if (!triedTargets.has(`button|${label.toLowerCase()}|`)) {
                  deferredDisabled.set(key, {
                    kind: 'button',
                    label,
                    score: 8,
                    depth: node.depth + 1,
                  });
                }
              }

              if (shouldCapture) {
                const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
                pushFinding({
                  scenarioName: `Explore via ${target.kind}: ${target.label}`.slice(0, 120),
                  url: pageUrl,
                  title: parsed.title || undefined,
                  snapshotExcerpt: accessibilityTree,
                  cuesSummary,
                  screenshotBase64: shot.artifactBase64 || undefined,
                  viaClick: target.label,
                }, probe, probeError);
                markVisited(pageUrl, { cuesSummary, clickLabel: target.label });
                if (urlChanged && node.depth + 1 < bounds.maxDepth) {
                  crawlFrontier.push({
                    url: pageUrl,
                    depth: node.depth + 1,
                    cuesSummary,
                  });
                }
              }

              // Return to frontier page for the next sibling control.
              await ensureOn(node.url).catch(() => undefined);
              // Refresh disabled list for subsequent siblings on this page.
              if (browser.evaluate) {
                try {
                  const out = await browser.evaluate({ script: CRAWL_LINK_DISCOVERY_SCRIPT });
                  pageDisabled = parseCrawlDiscovery(out.resultText || '')?.disabled ?? pageDisabled;
                } catch {
                  /* keep prior */
                }
              }
            } catch {
              clickOutcomes.push({
                control: target.label,
                kind: target.kind,
                urlBefore,
                urlAfter: currentUrl,
                changeSummary: 'click/nav error — soft-failed',
                changed: false,
                result: 'error',
              });
              await ensureOn(node.url).catch(() => undefined);
            }
          }

          // Re-queue landing once if deferred controls became enabled.
          if (
            !landingRetryQueued
            && deferredDisabled.size > 0
            && node.depth === 0
            && clicksDone < maxClicks
            && Date.now() - bounds.startedAt < bounds.maxMs
          ) {
            landingRetryQueued = true;
            crawlFrontier.push({
              url: node.url,
              depth: 0,
              cuesSummary: node.cuesSummary,
            });
          }
        }
      } finally {
        await browser.closeSession().catch(() => undefined);
      }

      if (details.length === 0) {
        throw new PlatformError('transient', `Explore UI opened ${input.url} but recorded no page snapshots.`);
      }

      const actionable = details.filter((d) => {
        const parsed = parseMcpPageSnapshot(d.snapshotExcerpt);
        if (!parsed.url) parsed.url = d.url;
        if (!parsed.title && d.title) parsed.title = d.title;
        return snapshotIsActionable(parsed);
      });

      if (actionable.length === 0) {
        const sample = details[0];
        const probe = probes[0];
        const reason = describeEmptyCapture({
          url: input.url,
          title: sample?.title,
          rawSnapshot: sample?.snapshotExcerpt,
          probe,
          probeError: probeErrors[0],
        });
        throw new PlatformError(
          'transient',
          `Explore UI reached ${sample?.url || input.url} but snapshot content is empty — not useful for test planning (${reason}).`,
        );
      }

      // Dedupe near-identical same-URL snapshots — keep first, note the gap.
      const unique: ExploreFinding[] = [];
      const seenFp = new Set<string>();
      for (const d of actionable) {
        const fp = `${(d.url || '').toLowerCase()}|${(d.cuesSummary || '').slice(0, 120).toLowerCase()}`;
        if (seenFp.has(fp)) continue;
        seenFp.add(fp);
        unique.push(d);
      }

      const findingsBody = unique
        .map((d) => {
          const cue = d.cuesSummary || d.snapshotExcerpt.replace(/\s+/g, ' ').slice(0, 280);
          return `- ${d.scenarioName} @ ${d.url}${d.title ? ` (${d.title})` : ''}\n  ${cue}`;
        })
        .join('\n');

      const clickFindings = formatClickFindings(clickOutcomes);
      const findingsText = [findingsBody, clickFindings].filter(Boolean).join('\n\n');
      const cues = parseExplorationCues(findingsText);
      const shopOnly = looksLikeShopSurface(cues, findingsText);
      const duplicate = hasNearDuplicateExploreFindings(findingsText) || actionable.length > unique.length;
      const templateMatch = unique.some((d) => exploredSurfaceMatchesKind('template', {
        url: d.url,
        title: d.title,
        headings: [],
        buttons: [],
        fields: [],
      }) || /template|email|notif|preview|greeting|paid amount/i.test(`${d.title || ''} ${d.cuesSummary || ''} ${d.snapshotExcerpt || ''}`));
      let warning = '';
      let relevant = true;
      let blockingGap = false;
      if (templateStory && shopOnly && !templateMatch) {
        warning = binding.templatePreviewUrl
          ? `Blocking explore gap: configured template preview ${binding.templatePreviewUrl} was not reachable as a template surface; only shop/catalog was found. Cases for email ACs must be Blocked (needs-surface), not Passed.`
          : 'Blocking explore gap: only the shop/catalog surface was reachable; escrow notification email template / preview was not found. Configure an environment Template preview URL (or QA_TEMPLATE_PREVIEW_URL). Do not treat catalog snapshots as email-field evidence — cases for those ACs must be Blocked (needs-surface), not Passed.';
        relevant = false;
        blockingGap = true;
      } else if (templateStory && templateMatch) {
        warning = '';
        relevant = true;
        blockingGap = false;
      } else if (duplicate && unique.length <= 1) {
        warning = 'Explore UI: near-duplicate same-URL snapshots across targets — counted as one surface, not distinct AC evidence.';
        relevant = !templateStory;
        blockingGap = templateStory;
      }

      const visitedUrls = [...new Set(unique.map((d) => d.url).filter(Boolean))];
      const primarySurfaceUrl = resolvePrimarySurfaceUrl(binding, visitedUrls)
        || (templateMatch ? visitedUrls.find((u) => exploredSurfaceMatchesKind('template', { url: u })) : undefined);
      const pageProgress = formatExplorePageProgress(visitedUrls.length > 0 ? visitedUrls : [input.url]);
      const clickCount = clickOutcomes.filter((o) => o.result !== 'skipped-disabled').length;
      const findings = [
        pageProgress,
        findingsBody,
        clickFindings,
        `\n- Story surface binding: kind=${binding.surfaceKind}`
          + (primarySurfaceUrl ? `; primary=${primarySurfaceUrl}` : '; primary=(unbound)')
          + (binding.templatePreviewUrl ? `; templatePreview=${binding.templatePreviewUrl}` : '')
          + (binding.candidateRoutes.length
            ? `; candidates=${binding.candidateRoutes.slice(0, 6).join(',')}`
            : ''),
        `\n- Multi-page explore: ${unique.length} distinct page snapshot${unique.length === 1 ? '' : 's'} (cap ${pageCap}, depth ≤ ${bounds.maxDepth}); ${clickCount} control click${clickCount === 1 ? '' : 's'} recorded`,
        warning ? `\n- Explore coverage warning: ${warning}` : '',
        blockingGap ? '\n- Blocking explore gap: true (fail closed — no Passed on mismatched surface)' : '',
        !blockingGap && templateMatch
          ? '\n- Template preview surface reached: true (assert subject/greeting/table/CTA/Paid Amount from WI)'
          : '',
        templateStory && analysis.searchTerms.length
          ? `\n- Story search terms (for template surfaces): ${analysis.searchTerms.slice(0, 8).join(', ')}`
          : '',
      ].filter(Boolean).join('\n');

      const urlList = (visitedUrls.length > 0 ? visitedUrls : [input.url]).join(', ');
      const summary = warning
        ? `${pageProgress} (${clickCount} clicks) for ${input.application} before planning (${unique.length} distinct surface${unique.length === 1 ? '' : 's'}: ${urlList}). ${warning}`
        : templateMatch
          ? `${pageProgress} (${clickCount} clicks) for ${input.application} — notification/template preview surface reached.`
          : `${pageProgress} (${clickCount} clicks) for ${input.application} before planning.`;
      return {
        summary,
        findings,
        details: unique,
        source: 'browser',
        warning: warning || undefined,
        relevant,
        blockingGap,
        surfaceKind: binding.surfaceKind,
        primarySurfaceUrl,
        ...(binding.templatePreviewUrl ? { templatePreviewUrl: binding.templatePreviewUrl } : {}),
        candidateRoutes: binding.candidateRoutes,
        pagesVisited: unique.length,
        exploredUrls: visitedUrls.length > 0 ? visitedUrls : [input.url],
        clickOutcomes,
      };
    },
  };
}

/**
 * Adapt ConnectorExecutionManager-style invokes into BrowserAutomationPort.
 * Catalog capabilities require `sessionId` on navigate/snapshot/screenshot/close;
 * we keep the id returned by `browser.session.open` and pass it on every call.
 */
export function browserPortFromInvoker(
  invoke: (capability: string, input?: Record<string, unknown>) => Promise<unknown>,
): BrowserAutomationPort {
  let sessionId = '';
  const withSession = (extra: Record<string, unknown> = {}) => {
    if (!sessionId) throw new PlatformError('validation', 'browser.navigate needs sessionId from browser.session.open first');
    return { sessionId, ...extra };
  };
  return {
    async openSession() {
      const out = await invoke('browser.session.open', {}) as { sessionId?: string };
      sessionId = typeof out?.sessionId === 'string' ? out.sessionId.trim() : '';
      if (!sessionId) {
        throw new PlatformError('validation', 'browser.session.open did not return a sessionId');
      }
    },
    async navigate(url: string) {
      const out = await invoke('browser.navigate', withSession({ url })) as {
        finalUrl?: string;
        accessibilityTree?: string;
        title?: string;
      };
      return {
        finalUrl: out?.finalUrl ?? url,
        accessibilityTree: out?.accessibilityTree,
        title: out?.title,
      };
    },
    async waitFor(input) {
      try {
        const out = await invoke('browser.wait', withSession({
          timeSeconds: input?.timeSeconds,
          text: input?.text,
        })) as { accessibilityTree?: string; url?: string; title?: string };
        return out;
      } catch (e) {
        // Older connectors may lack browser.wait — fall back to a local settle.
        if (e instanceof PlatformError && (e.errorClass === 'unsupported' || e.errorClass === 'denied')) {
          const ms = Math.min(30_000, Math.max(0, (input?.timeSeconds ?? 1.5) * 1000));
          await sleep(ms);
          return;
        }
        throw e;
      }
    },
    async evaluate(input) {
      const out = await invoke('browser.evaluate', withSession({ script: input.script })) as {
        resultText?: string;
        accessibilityTree?: string;
        url?: string;
        title?: string;
      };
      return {
        resultText: out?.resultText ?? '',
        accessibilityTree: out?.accessibilityTree,
        url: out?.url,
        title: out?.title,
      };
    },
    async interact(input) {
      await invoke('browser.interact', withSession({
        action: input.action,
        target: input.target,
        value: input.value,
      }));
    },
    async snapshot() {
      const out = await invoke('browser.snapshot', withSession()) as {
        accessibilityTree?: string;
        url?: string;
        title?: string;
      };
      return {
        accessibilityTree: out?.accessibilityTree ?? '',
        url: out?.url ?? '',
        title: out?.title,
      };
    },
    async screenshot() {
      const out = await invoke('browser.screenshot', withSession()) as { artifactBase64?: string };
      return { artifactBase64: out?.artifactBase64 ?? '' };
    },
    async closeSession() {
      if (!sessionId) return;
      const id = sessionId;
      sessionId = '';
      await invoke('browser.session.close', { sessionId: id });
    },
  };
}
