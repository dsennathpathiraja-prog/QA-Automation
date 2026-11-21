import { PlatformError } from '@qa/domain';
import {
  DOM_PROBE_SCRIPT,
  describeEmptyCapture,
  dnsExtraHostsGuidance,
  domProbeIsActionable,
  isBrowserNavigationFailure,
  parseEvaluateToolResult,
  parsedSnapshotFromDomProbe,
  type DomProbeResult,
} from './dom-probe';
import {
  parseMcpPageSnapshot,
  snapshotArtifactBody,
  snapshotIsActionable,
  summarizeSnapshotForFindings,
} from './snapshot-content';
import type { BrowserAutomationPort, BrowserExplorerPort, ExploreFinding, ExploreRequest, ExploreResult } from './types';

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
  throw new PlatformError('transient', dnsExtraHostsGuidance(input.targetUrl));
}

/**
 * Capture a snapshot useful for planning: SPA settle, aria retries, then DOM/iframe
 * evaluate when the accessibility tree is empty (PayNSure shop / SDK shells).
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
 * findings can feed the Markdown test plan. Failures throw — Explore UI must
 * succeed with a real session + navigate + non-empty snapshot before planning.
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

      const labels = input.scenarios.length > 0
        ? input.scenarios.map((s) => s.name)
        : (input.criteria?.length ? input.criteria : [input.application]).map((c) => `Explore: ${c}`);
      const details: ExploreFinding[] = [];
      const probes: Array<DomProbeResult | undefined> = [];
      const probeErrors: Array<string | undefined> = [];
      const limit = Math.min(input.maxPages ?? 5, Math.max(1, labels.length), 8);
      try {
        await browser.openSession();
        const nav = await browser.navigate(input.url);

        // Fail fast on chrome-error / DNS before spending retries on empty aria trees.
        throwIfNavigationFailed({
          targetUrl: input.url,
          pageUrl: nav.finalUrl,
          raw: nav.accessibilityTree,
        });

        // Prefer a snapshot already attached to navigate when the tree is rich enough.
        if (nav.accessibilityTree) {
          const fromNav = parseMcpPageSnapshot(nav.accessibilityTree);
          if (!fromNav.url) fromNav.url = nav.finalUrl || input.url;
          if (!fromNav.title && nav.title) fromNav.title = nav.title;
          if (snapshotIsActionable(fromNav) && labels.length === 1) {
            const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
            details.push({
              scenarioName: labels[0]!,
              url: fromNav.url || nav.finalUrl || input.url,
              title: fromNav.title || undefined,
              snapshotExcerpt: snapshotArtifactBody(fromNav),
              cuesSummary: summarizeSnapshotForFindings(fromNav),
              screenshotBase64: shot.artifactBase64 || undefined,
            });
            probes.push(undefined);
            probeErrors.push(undefined);
          }
        }

        // One early DOM probe when navigate aria is empty — reused by capture (no evaluate spam).
        let earlyProbe: { probe?: DomProbeResult; error?: string } | undefined;
        if (details.length === 0 && browser.evaluate) {
          earlyProbe = await probeDom(browser, { reNavigateUrl: input.url });
          throwIfNavigationFailed({
            targetUrl: input.url,
            pageUrl: earlyProbe.probe?.url || nav.finalUrl,
            raw: nav.accessibilityTree,
            probe: earlyProbe.probe,
          });
          if (domProbeIsActionable(earlyProbe.probe) && labels.length === 1) {
            const fromDom = parsedSnapshotFromDomProbe(earlyProbe.probe!);
            const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
            details.push({
              scenarioName: labels[0]!,
              url: fromDom.url || nav.finalUrl || input.url,
              title: fromDom.title || undefined,
              snapshotExcerpt: snapshotArtifactBody(fromDom),
              cuesSummary: summarizeSnapshotForFindings(fromDom),
              screenshotBase64: shot.artifactBase64 || undefined,
            });
            probes.push(earlyProbe.probe);
            probeErrors.push(undefined);
          }
        }

        for (let i = details.length; i < limit; i += 1) {
          const label = labels[i] ?? `page-${i + 1}`;
          const { parsed, accessibilityTree, probe, probeError } = await captureActionableSnapshot(
            browser,
            nav.finalUrl || input.url,
            input.url,
            earlyProbe,
          );
          const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
          details.push({
            scenarioName: label,
            url: parsed.url || nav.finalUrl || input.url,
            title: parsed.title || undefined,
            snapshotExcerpt: accessibilityTree,
            cuesSummary: summarizeSnapshotForFindings(parsed),
            screenshotBase64: shot.artifactBase64 || undefined,
          });
          probes.push(probe);
          probeErrors.push(probeError);
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

      const findings = actionable
        .map((d) => {
          const cue = d.cuesSummary || d.snapshotExcerpt.replace(/\s+/g, ' ').slice(0, 280);
          return `- ${d.scenarioName} @ ${d.url}${d.title ? ` (${d.title})` : ''}\n  ${cue}`;
        })
        .join('\n');
      const visitedUrls = [...new Set(actionable.map((d) => d.url).filter(Boolean))];
      const urlList = (visitedUrls.length > 0 ? visitedUrls : [input.url]).join(', ');
      return {
        summary: `Visited ${urlList} (${actionable.length} page snapshot${actionable.length === 1 ? '' : 's'}) for ${input.application} before planning.`,
        findings,
        details: actionable,
        source: 'browser',
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
