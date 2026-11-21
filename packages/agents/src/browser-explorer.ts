import { PlatformError } from '@qa/domain';
import {
  parseMcpPageSnapshot,
  snapshotArtifactBody,
  snapshotIsActionable,
  summarizeSnapshotForFindings,
} from './snapshot-content';
import type { BrowserAutomationPort, BrowserExplorerPort, ExploreFinding, ExploreRequest, ExploreResult } from './types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Capture a snapshot that is useful for planning: wait for SPA settle, retry
 * when the tree is empty, and prefer YAML aria content over raw MCP chrome.
 */
async function captureActionableSnapshot(
  browser: BrowserAutomationPort,
  fallbackUrl: string,
): Promise<{ parsed: ReturnType<typeof parseMcpPageSnapshot>; accessibilityTree: string }> {
  const attempts = 3;
  let lastRaw = '';
  let lastUrl = fallbackUrl;
  let lastTitle = '';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt === 0 && browser.waitFor) {
      await browser.waitFor({ timeSeconds: 1.5 }).catch(() => undefined);
    } else if (attempt > 0) {
      if (browser.waitFor) {
        await browser.waitFor({ timeSeconds: 1 }).catch(() => undefined);
      } else {
        await sleep(800);
      }
    }

    try {
      const snap = await browser.snapshot();
      lastRaw = snap.accessibilityTree ?? '';
      lastUrl = snap.url || fallbackUrl;
      lastTitle = snap.title ?? '';
    } catch {
      // Provider may throw on a truly empty MCP payload; retry after wait.
      continue;
    }
    const parsed = parseMcpPageSnapshot(lastRaw);
    if (!parsed.url && lastUrl) parsed.url = lastUrl;
    if (!parsed.title && lastTitle) parsed.title = lastTitle;
    if (snapshotIsActionable(parsed)) {
      return { parsed, accessibilityTree: snapshotArtifactBody(parsed) || lastRaw };
    }
  }

  const parsed = parseMcpPageSnapshot(lastRaw);
  if (!parsed.url && lastUrl) parsed.url = lastUrl;
  if (!parsed.title && lastTitle) parsed.title = lastTitle;
  return { parsed, accessibilityTree: snapshotArtifactBody(parsed) || lastRaw };
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
      const limit = Math.min(input.maxPages ?? 5, Math.max(1, labels.length), 8);
      try {
        await browser.openSession();
        const nav = await browser.navigate(input.url);
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
          }
        }

        for (let i = details.length; i < limit; i += 1) {
          const label = labels[i] ?? `page-${i + 1}`;
          const { parsed, accessibilityTree } = await captureActionableSnapshot(browser, nav.finalUrl || input.url);
          const shot = await browser.screenshot().catch(() => ({ artifactBase64: '' }));
          details.push({
            scenarioName: label,
            url: parsed.url || nav.finalUrl || input.url,
            title: parsed.title || undefined,
            snapshotExcerpt: accessibilityTree,
            cuesSummary: summarizeSnapshotForFindings(parsed),
            screenshotBase64: shot.artifactBase64 || undefined,
          });
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
        const reason = sample?.title
          ? `page title "${sample.title}" but no accessibility tree / interactive cues`
          : 'empty accessibility snapshot (page blank, still loading, iframe-only, or MCP returned no content)';
        throw new PlatformError(
          'transient',
          `Explore UI reached ${input.url} but snapshot content is empty — not useful for test planning (${reason}). ` +
            'Wait for the app to finish loading, confirm the shop URL renders outside an opaque iframe, then retry Explore UI.',
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
      // Local settle only — MCP wait is performed inside browser.navigate on the connector.
      const ms = Math.min(30_000, Math.max(0, (input?.timeSeconds ?? 1.5) * 1000));
      await sleep(ms);
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
