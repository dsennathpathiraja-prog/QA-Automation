/** Shared shapes for requirement-validation planner / generator / browser agents. */

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
  steps: string;
  expected: string;
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
  executionId?: string;
  stepId?: string;
}

export interface PlanResult {
  summary: string;
  scenarios: PlannerScenario[];
  /** How the plan was produced. */
  source: 'model' | 'heuristic' | 'mcp';
}

export interface GenerateRequest {
  workItem: string;
  application: string;
  scenarios: PlannerScenario[];
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

export interface ExploreRequest {
  application: string;
  /** Absolute URL the browser may open (must be on the connector allowlist). */
  url?: string;
  environment?: string;
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

export interface BrowserExplorerPort {
  explore(input: ExploreRequest): Promise<ExploreResult>;
}

/** Thin browser connector surface used by the in-repo explorer (maps to playwright-mcp capabilities). */
export interface BrowserAutomationPort {
  openSession(): Promise<void>;
  navigate(url: string): Promise<{ finalUrl: string }>;
  snapshot(): Promise<{ accessibilityTree: string; url: string }>;
  screenshot(): Promise<{ artifactBase64: string }>;
  closeSession(): Promise<void>;
}
