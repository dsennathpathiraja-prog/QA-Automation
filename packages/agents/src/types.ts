/** Shared shapes for requirement-validation planner / generator / healer / browser agents. */

export type ScenarioKind = 'positive' | 'negative' | 'edge';
export type ScenarioPriority = 'high' | 'medium' | 'low';

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
}

export interface PlanRequest {
  workItem: string;
  application: string;
  /** Full story blob (title, description, acceptance criteria). */
  story: string;
  criteria: string[];
  /** Exploration findings from UI / source (available before planning). */
  findings?: string;
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
  snapshotExcerpt: string;
  screenshotBase64?: string;
}

export interface ExploreResult {
  summary: string;
  findings: string;
  details: ExploreFinding[];
  source: 'browser' | 'skipped' | 'mcp';
}

export interface CodeExploreRequest {
  application: string;
  workItem?: string;
  /** Bound repository name when known; otherwise the connector config supplies it. */
  repo?: string;
  criteria?: string[];
  maxFiles?: number;
  maxQueries?: number;
  executionId?: string;
  stepId?: string;
}

export interface CodeFinding {
  path: string;
  query: string;
  snippet: string;
  contentExcerpt: string;
}

export interface CodeExploreResult {
  summary: string;
  findings: string;
  details: CodeFinding[];
  source: 'repo';
  repo?: string;
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
  navigate(url: string): Promise<{ finalUrl: string }>;
  snapshot(): Promise<{ accessibilityTree: string; url: string }>;
  screenshot(): Promise<{ artifactBase64: string }>;
  closeSession(): Promise<void>;
}

/** Thin source-repo surface for Explore code (scm.code.search + scm.file.read). */
export interface SourceRepoPort {
  search(input: { query: string; repo?: string; branch?: string }): Promise<{ path: string; snippet: string }[]>;
  readFile(input: { path: string; repo?: string; branch?: string }): Promise<{ path: string; content: string; truncated: boolean }>;
}
