import { isPlatformError } from '@qa/domain';
import type { BrowserAutomationPort, BrowserExplorerPort, ExploreFinding, ExploreRequest, ExploreResult } from './types';

/**
 * In-repo explorer that drives the managed Playwright MCP connector
 * (same role as Cursor's playwright-browser MCP). Runs BEFORE the planner so
 * findings can feed the Markdown test plan. Skips cleanly when no URL or no
 * browser port is available — RV runs stay usable without a browser.
 */
export function createBrowserExplorer(browser: BrowserAutomationPort | undefined): BrowserExplorerPort {
  return {
    async explore(input: ExploreRequest): Promise<ExploreResult> {
      if (!input.url) {
        return {
          summary: input.environment
            ? `UI note for ${input.application} on ${input.environment}: no openable address was resolved for this run.`
            : 'UI note: no environment was given, so the screen was not opened.',
          findings: input.environment ? `environment ${input.environment}` : 'no environment',
          details: [],
          source: 'skipped',
        };
      }
      if (!browser) {
        return {
          summary: `UI note for ${input.application}: environment address is known (${input.url}) but no Playwright browser connector is bound.`,
          findings: `url ${input.url}; browser not bound`,
          details: [],
          source: 'skipped',
        };
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
      } catch (e) {
        // Explore UI is best-effort before planning: surface the URL and reason instead of failing the run blankly.
        if (isPlatformError(e) || e instanceof Error) {
          const reason = e instanceof Error ? e.message : 'unknown error';
          return {
            summary: `UI note for ${input.application}: could not explore ${input.url} (${reason}).`,
            findings: `url ${input.url}; browser unavailable`,
            details: [],
            source: 'skipped',
          };
        }
        throw e;
      } finally {
        await browser.closeSession().catch(() => undefined);
      }

      const findings = details.length > 0
        ? details.map((d) => `- ${d.scenarioName} @ ${d.url}\n  ${d.snapshotExcerpt.slice(0, 280).replace(/\s+/g, ' ')}`).join('\n')
        : `opened ${input.url}`;
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

/** Adapt ConnectorExecutionManager-style invokes into BrowserAutomationPort. */
export function browserPortFromInvoker(
  invoke: (capability: string, input?: Record<string, unknown>) => Promise<unknown>,
): BrowserAutomationPort {
  return {
    async openSession() {
      await invoke('browser.session.open', {});
    },
    async navigate(url: string) {
      const out = await invoke('browser.navigate', { url }) as { finalUrl?: string };
      return { finalUrl: out?.finalUrl ?? url };
    },
    async snapshot() {
      const out = await invoke('browser.snapshot', {}) as { accessibilityTree?: string; url?: string };
      return { accessibilityTree: out?.accessibilityTree ?? '', url: out?.url ?? '' };
    },
    async screenshot() {
      const out = await invoke('browser.screenshot', {}) as { artifactBase64?: string };
      return { artifactBase64: out?.artifactBase64 ?? '' };
    },
    async closeSession() {
      await invoke('browser.session.close', {});
    },
  };
}
