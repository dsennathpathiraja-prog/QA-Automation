/** Shared shapes for requirement-validation planner / generator / healer / browser agents. */

export type ScenarioKind = 'positive' | 'negative' | 'edge';
export type ScenarioPriority = 'high' | 'medium' | 'low';
/** Story-expected UI surface for validation (Phase 8 E1). */
export type SurfaceKind = 'shop' | 'template' | 'other';
/** Intended execution outcome when explore cannot cover the required surface. */
export type GeneratedCaseRunStatus = 'Blocked' | 'Skipped';

export interface PlannerScenario {
  name: string;
  kind: ScenarioKind;
  priority: ScenarioPriority;
  criterion: string;
  steps: string;
  expected: string;
}

export interface GeneratedPlaywrightCase {
  name: string;
  kind: ScenarioKind;
  priority: ScenarioPriority;
  /** Playwright `.spec.js` source for the platform library / runner. */
  steps: string;
  expected: string;
  /**
   * Human validation steps for Squash (`action` + `expected_result`).
   * When omitted, publish derives them from a `// Steps:` comment or a name/expected fallback.
   */
  validationSteps?: { action: string; expected: string }[];
  workItem: string;
  reference: string;
  file: string;
  testId: string;
  /** Execute should treat as Blocked/Skipped (surface gap) instead of asserting on a mismatched host. */
  runStatus?: GeneratedCaseRunStatus;
  /** e.g. `needs-surface` when the primary validation URL/surface was never reached. */
  tags?: string[];
  /** Bound primary validation URL when known. */
  primarySurfaceUrl?: string;
  surfaceKind?: SurfaceKind;
}

export interface PlanRequest {
  workItem: string;
  application: string;
  /** Full story blob (title, description, acceptance criteria). */
  story: string;
  criteria: string[];
  /** Exploration findings from UI / source (available before planning). */
  findings?: string;
  /** Environment application URL used during Explore (for surface binding). */
  environmentUrl?: string;
  /** Optional notification/email template preview URL from environment settings. */
  templatePreviewUrl?: string;
  executionId?: string;
  stepId?: string;
}

export interface PlanResult {
  summary: string;
  scenarios: PlannerScenario[];
  /** Durable Markdown plan artifact body for the generator. */
  planMarkdown: string;
  /** Relative path of the plan artifact in the platform workspace. */
  planArtifact: string;
  /** How the plan was produced. */
  source: 'model' | 'heuristic' | 'mcp';
  /** Weak / mismatched Explore UI coverage (duplicate snapshots, wrong surface). */
  exploreWarning?: string;
  /** Structural fail-closed gap: explored surface does not match the story. */
  blockingGap?: boolean;
  surfaceKind?: SurfaceKind;
  primarySurfaceUrl?: string;
}

export interface GenerateRequest {
  workItem: string;
  application: string;
  scenarios: PlannerScenario[];
  /** Markdown plan artifact from playwright-test-planner (preferred generator input). */
  planMarkdown?: string;
  planArtifact?: string;
  /** Optional notes from UI / source exploration. */
  findings?: string;
  /** Full story blob for surface binding when findings are weak. */
  story?: string;
  environmentUrl?: string;
  /** Optional notification/email template preview URL from environment settings. */
  templatePreviewUrl?: string;
  executionId?: string;
  stepId?: string;
}

export interface GenerateResult {
  summary: string;
  cases: GeneratedPlaywrightCase[];
  source: 'model' | 'heuristic' | 'mcp';
}

export interface HealFailure {
  testId?: string;
  name?: string;
  error: string;
}

export interface HealRequest {
  workItem: string;
  application: string;
  cases: GeneratedPlaywrightCase[];
  findings?: string;
  /** Optional run/diagnostic failures to target. */
  failures?: HealFailure[];
  executionId?: string;
  stepId?: string;
}

export interface HealResult {
  summary: string;
  cases: GeneratedPlaywrightCase[];
  fixed: number;
  source: 'model' | 'heuristic' | 'mcp';
}

export interface ExploreRequest {
  application: string;
  /** Absolute URL the browser may open (must be on the connector allowlist). */
  url?: string;
  environment?: string;
  /**
   * Optional notification/email template preview URL (environment setting or
   * `QA_TEMPLATE_PREVIEW_URL`). When set for template WIs, Explore starts here.
   */
  templatePreviewUrl?: string;
  /** Work item title — used with story to decide template vs shop surfaces. */
  workItemTitle?: string;
  /** Full story blob for story-driven explore targets. */
  story?: string;
  /** Optional criteria / path labels when exploring before the plan exists. */
  criteria?: string[];
  scenarios: PlannerScenario[];
  /** Cap pages / screenshots for a single run. */
  maxPages?: number;
  executionId?: string;
  stepId?: string;
}

export interface ExploreFinding {
  scenarioName: string;
  url: string;
  /** Page title from the MCP snapshot, when present. */
  title?: string;
  /**
   * Accessibility tree (prefer YAML) for the MD artifact / planner.
   * Must be non-empty for Explore UI to succeed.
   */
  snapshotExcerpt: string;
  /** Compact cues (links / buttons / fields / headings) for findings. */
  cuesSummary?: string;
  screenshotBase64?: string;
}

export interface ExploreResult {
  summary: string;
  findings: string;
  details: ExploreFinding[];
  source: 'browser' | 'skipped' | 'mcp';
  /** Weak explore: duplicate same-URL snapshots and/or surface mismatch vs story. */
  warning?: string;
  /** False when findings are not useful as distinct scenario evidence. */
  relevant?: boolean;
  /** True when only a mismatched surface was reached (e.g. shop for email template WI). */
  blockingGap?: boolean;
  surfaceKind?: SurfaceKind;
  /** Primary validation URL when known from WI, env preview, or a matching explore hit. */
  primarySurfaceUrl?: string;
  /** Configured template preview URL when present. */
  templatePreviewUrl?: string;
  /** Candidate routes tried / suggested beyond the environment root. */
  candidateRoutes?: string[];
}

export interface CodeExploreRequest {
  application: string;
  workItem?: string;
  /** Work item title from Read — preferred search seed over application name. */
  workItemTitle?: string;
  /** Full story blob (title + description + AC) for story-derived search terms. */
  story?: string;
  /** Bound repository name when known; otherwise the connector config supplies it. */
  repo?: string;
  criteria?: string[];
  /** Cap files / excerpts for a single run. */
  maxFiles?: number;
  maxQueries?: number;
  executionId?: string;
  stepId?: string;
}

export interface CodeFinding {
  path: string;
  excerpt: string;
  query?: string;
}

export interface CodeExploreResult {
  summary: string;
  findings: string;
  details: CodeFinding[];
  source: 'repo';
  repo?: string;
  /** False when hits are empty/path-only or search was refused (app-name-only). */
  relevant?: boolean;
  warning?: string;
}

/**
 * Capability ports the worker binds. In-repo defaults use the LLM gateway and
 * Playwright MCP connector; Cursor MCP packages can implement the same ports.
 */
export interface TestPlannerPort {
  plan(input: PlanRequest): Promise<PlanResult>;
}

export interface TestGeneratorPort {
  generate(input: GenerateRequest): Promise<GenerateResult>;
}

export interface TestHealerPort {
  heal(input: HealRequest): Promise<HealResult>;
}

export interface BrowserExplorerPort {
  explore(input: ExploreRequest): Promise<ExploreResult>;
}

export interface CodeExplorerPort {
  explore(input: CodeExploreRequest): Promise<CodeExploreResult>;
}

/** Thin browser connector surface used by the in-repo explorer (maps to playwright-mcp capabilities). */
export interface BrowserAutomationPort {
  openSession(): Promise<void>;
  navigate(url: string): Promise<{ finalUrl: string; accessibilityTree?: string; title?: string }>;
  /** Optional settle wait after navigate (Playwright MCP `browser_wait_for`). */
  waitFor?(input?: { timeSeconds?: number; text?: string }): Promise<{ accessibilityTree?: string; url?: string; title?: string } | void>;
  /**
   * Optional JS evaluate (Playwright MCP `browser_evaluate`) for DOM/iframe probes
   * when the accessibility snapshot is empty.
   */
  evaluate?(input: { script: string }): Promise<{ resultText: string; accessibilityTree?: string; url?: string; title?: string }>;
  /** Optional click/type when Explore needs to open a shop modal (observe-safe targets only). */
  interact?(input: { action: 'click' | 'type' | 'select' | 'press'; target: string; value?: string }): Promise<void>;
  snapshot(): Promise<{ accessibilityTree: string; url: string; title?: string }>;
  screenshot(): Promise<{ artifactBase64: string }>;
  closeSession(): Promise<void>;
}

/**
 * Thin source-repo surface for Explore code.
 * Callers may omit `repo` when the connector binds one; the manager injects config.repo.
 */
export interface SourceRepoPort {
  search(input: { query: string; repo?: string; branch?: string }): Promise<{ items: { path: string; snippet: string }[] }>;
  listTree(input?: { path?: string; repo?: string; branch?: string }): Promise<{ entries: { path: string; type: 'file' | 'dir' }[] }>;
  readFile(input: { path: string; repo?: string; branch?: string }): Promise<{ path: string; content: string; truncated: boolean }>;
}
