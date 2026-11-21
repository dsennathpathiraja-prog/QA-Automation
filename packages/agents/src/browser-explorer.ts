import { PlatformError } from '@qa/domain';
import type { BrowserAutomationPort, BrowserExplorerPort, ExploreFinding, ExploreRequest, ExploreResult } from './types';

/**
 * In-repo explorer that drives the managed Playwright MCP connector
 * (same role as Cursor's playwright-browser MCP). Runs BEFORE the planner so
 * findings can feed the Markdown test plan. Failures throw — Explore UI must
 * succeed with a real session + navigate before planning.
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
        await browser.navigate(input.url);
        for (let i = 0; i < limit; i += 1) {
          const label = labels[i] ?? `page-${i + 1}`;
          const snap = await browser.snapshot();
          const shot = await browser.screenshot();
          details.push({
            scenarioName: label,
            url: snap.url || input.url,
            snapshotExcerpt: (snap.accessibilityTree ?? '').slice(0, 1_500),
            screenshotBase64: shot.artifactBase64 || undefined,
          });
        }
      } finally {
        await browser.closeSession().catch(() => undefined);
      }

      if (details.length === 0) {
        throw new PlatformError('transient', `Explore UI opened ${input.url} but recorded no page snapshots.`);
      }

      const findings = details
        .map((d) => `- ${d.scenarioName} @ ${d.url}\n  ${d.snapshotExcerpt.slice(0, 280).replace(/\s+/g, ' ')}`)
        .join('\n');
      const visitedUrls = [...new Set(details.map((d) => d.url).filter(Boolean))];
      const urlList = (visitedUrls.length > 0 ? visitedUrls : [input.url]).join(', ');
      return {
        summary: `Visited ${urlList} (${details.length} page snapshot${details.length === 1 ? '' : 's'}) for ${input.application} before planning.`,
        findings,
        details,
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
      const out = await invoke('browser.navigate', withSession({ url })) as { finalUrl?: string };
      return { finalUrl: out?.finalUrl ?? url };
    },
    async snapshot() {
      const out = await invoke('browser.snapshot', withSession()) as { accessibilityTree?: string; url?: string };
      return { accessibilityTree: out?.accessibilityTree ?? '', url: out?.url ?? '' };
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
