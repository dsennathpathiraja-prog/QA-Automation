/**
 * Adapter contracts for Cursor / local MCP servers that play the same three roles
 * as the in-repo agents. Names match common catalogs; configure them in
 * `.cursor/mcp.json` (see docs/playwright-agents-mcp.md).
 *
 * These interfaces are intentionally free of Cursor SDK types so the platform
 * stays connector-first: the worker never embeds MCP client packages. Local
 * Cursor sessions call the MCP servers directly; the platform worker uses the
 * in-repo ports in `types.ts` instead.
 */

import type {
  BrowserExplorerPort,
  ExploreRequest,
  ExploreResult,
  GenerateRequest,
  GenerateResult,
  PlanRequest,
  PlanResult,
  TestGeneratorPort,
  TestPlannerPort,
} from './types';

/** Catalog keys operators may see in Cursor / MCP marketplaces. */
export const PLAYWRIGHT_MCP_ROLES = {
  planner: 'playwright-test-planner',
  generator: 'playwright-test-generator',
  /** Managed browser MCP used by the platform connector (`playwright-mcp` provider). */
  browser: 'playwright-browser',
  browserManaged: 'playwright-mcp',
} as const;

export type PlaywrightMcpRole = (typeof PLAYWRIGHT_MCP_ROLES)[keyof typeof PLAYWRIGHT_MCP_ROLES];

/**
 * Expected tool surface when a Cursor MCP package exposes a planner.
 * Map package-specific tool names onto `plan` when adapting.
 */
export interface PlaywrightTestPlannerMcp {
  /** Typical tool: `planner_generate_plan` or `create_test_plan`. */
  plan(input: {
    story: string;
    acceptanceCriteria: string[];
    application: string;
    workItem: string;
  }): Promise<{
    scenarios: Array<{
      name: string;
      kind: 'positive' | 'negative' | 'edge';
      priority?: 'high' | 'medium' | 'low';
      criterion: string;
      steps: string;
      expected: string;
    }>;
  }>;
}

/** Expected tool surface for a generator MCP (e.g. `generator_write_tests`). */
export interface PlaywrightTestGeneratorMcp {
  generate(input: {
    workItem: string;
    application: string;
    scenarios: Array<{
      name: string;
      kind: 'positive' | 'negative' | 'edge';
      priority?: 'high' | 'medium' | 'low';
      criterion: string;
      steps: string;
      expected: string;
    }>;
    findings?: string;
  }): Promise<{
    cases: Array<{
      name: string;
      kind: 'positive' | 'negative' | 'edge';
      priority?: 'high' | 'medium' | 'low';
      steps: string;
      expected: string;
      file?: string;
      testId?: string;
    }>;
  }>;
}

/**
 * Expected tool surface for a browser MCP (Cursor `playwright` / `playwright-browser`
 * or the platform-managed `playwright-mcp` connector tools).
 */
export interface PlaywrightBrowserMcp {
  navigate(url: string): Promise<void>;
  snapshot(): Promise<{ text: string; url?: string }>;
  takeScreenshot(opts?: { fullPage?: boolean }): Promise<{ data: string }>;
  close(): Promise<void>;
}

/** Wrap a planner MCP client as the platform `TestPlannerPort`. */
export function plannerPortFromMcp(mcp: PlaywrightTestPlannerMcp): TestPlannerPort {
  return {
    async plan(input: PlanRequest): Promise<PlanResult> {
      const out = await mcp.plan({
        story: input.story,
        acceptanceCriteria: input.criteria,
        application: input.application,
        workItem: input.workItem,
      });
      const scenarios = out.scenarios.map((row) => ({
        name: row.name,
        kind: row.kind,
        priority: row.priority ?? (row.kind === 'negative' ? 'high' as const : row.kind === 'edge' ? 'low' as const : 'medium' as const),
        criterion: row.criterion,
        steps: row.steps,
        expected: row.expected,
      }));
      return {
        summary: `${PLAYWRIGHT_MCP_ROLES.planner} (MCP) wrote ${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'} for ${input.workItem}.`,
        scenarios: scenarios.slice(0, 40),
        source: 'mcp',
      };
    },
  };
}

/** Wrap a generator MCP client as the platform `TestGeneratorPort`. */
export function generatorPortFromMcp(mcp: PlaywrightTestGeneratorMcp): TestGeneratorPort {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'case';
  return {
    async generate(input: GenerateRequest): Promise<GenerateResult> {
      const out = await mcp.generate({
        workItem: input.workItem,
        application: input.application,
        scenarios: input.scenarios,
        findings: input.findings,
      });
      const work = slug(input.workItem);
      const application = slug(input.application);
      const cases = out.cases.slice(0, 40).map((row, index) => ({
        name: row.name,
        kind: row.kind,
        priority: row.priority ?? (row.kind === 'negative' ? 'high' as const : row.kind === 'edge' ? 'low' as const : 'medium' as const),
        steps: row.steps,
        expected: row.expected,
        workItem: input.workItem,
        reference: `QAP-${work}-${index + 1}`.slice(0, 50),
        file: row.file ?? `tests/${application}/${work}.spec.js`,
        testId: row.testId ?? `${work}-${row.kind}-${index + 1}`,
      }));
      return {
        summary: `${PLAYWRIGHT_MCP_ROLES.generator} (MCP) wrote ${cases.length} Playwright test${cases.length === 1 ? '' : 's'} for ${input.workItem}.`,
        cases,
        source: 'mcp',
      };
    },
  };
}

/** Wrap a browser MCP client as the platform `BrowserExplorerPort` (navigate + snapshot + screenshot). */
export function explorerPortFromBrowserMcp(mcp: PlaywrightBrowserMcp): BrowserExplorerPort {
  return {
    async explore(input: ExploreRequest): Promise<ExploreResult> {
      if (!input.url) {
        return {
          summary: input.environment
            ? `UI note for ${input.application} on ${input.environment}: no openable address was resolved.`
            : 'UI note: no environment was given, so the screen was not opened.',
          findings: 'no environment',
          details: [],
          source: 'skipped',
        };
      }
      const details = [];
      const limit = Math.min(input.maxPages ?? 5, Math.max(1, input.scenarios.length || 1));
      try {
        await mcp.navigate(input.url);
        for (let i = 0; i < limit; i += 1) {
          const scenario = input.scenarios[i];
          const snap = await mcp.snapshot();
          const shot = await mcp.takeScreenshot({ fullPage: true });
          details.push({
            scenarioName: scenario?.name ?? `page-${i + 1}`,
            url: snap.url ?? input.url,
            snapshotExcerpt: (snap.text ?? '').slice(0, 1_500),
            screenshotBase64: shot.data || undefined,
          });
        }
      } finally {
        await mcp.close().catch(() => undefined);
      }
      const findings = details.map((d) => `${d.scenarioName} @ ${d.url}: ${d.snapshotExcerpt.slice(0, 240)}`).join('\n') || `opened ${input.url}`;
      return {
        summary: `${PLAYWRIGHT_MCP_ROLES.browser} opened ${details.length} page${details.length === 1 ? '' : 's'} for ${input.application}.`,
        findings,
        details,
        source: 'mcp',
      };
    },
  };
}
