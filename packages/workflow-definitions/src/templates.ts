import type { WfConnector, WfDef, WfParameter, WfStep, WorkflowKind } from './types';

export interface TemplateInfo {
  key: string;
  name: string;
  type: WorkflowKind;
  summary: string;
  definition: WfDef;
}

const step = (id: string, type: string, extra: Partial<WfStep>): WfStep => ({
  id, type, typeVersion: 1, enabled: true, mandatory: extra.mandatory ?? true, dependsOn: [], config: {}, inputs: {}, ...extra,
});

const connector = (role: string, category: string, required: string[], optional: string[] = [], requiredRole = true): WfConnector => ({
  role, category, requiredCapabilities: required, optionalCapabilities: optional, optional: !requiredRole, binding: { connectorInstanceId: category === 'test-runner' ? 'managed' : null },
});

const env = (kinds: string[], production = false) => ({
  mode: 'required', allowedKinds: kinds, pinnedEnvironmentId: null, production: { allowed: production, requiresApproval: true },
});

const execution = (maxParallelism: number, timeoutMinutes: number, onStepFailure = 'stop') => ({
  maxParallelism, timeoutMinutes, onStepFailure, schedule: null, retention: { artifactDays: 180 },
});

const base = (key: string, name: string, description: string, type: WorkflowKind, spec: WfDef['spec']): WfDef => ({
  schemaVersion: '1.0', kind: 'WorkflowDefinition',
  metadata: { key, name, description, type, typeVersion: 1, templateRef: null },
  spec,
});

function rvSteps(mode: 'standard' | 'ui' | 'code' | 'both'): WfStep[] {
  const ui = mode !== 'code';
  const code = mode !== 'ui';
  const uiOn = mode !== 'code';
  const codeOn = mode === 'code' || mode === 'both';
  const exploreDeps = [ui && uiOn ? 'explore_ui' : '', code && codeOn ? 'explore_code' : ''].filter((x) => x !== '');
  const findings: Record<string, string> = {};
  if (ui && uiOn) findings.uiFindings = '${steps.explore_ui.outputs.findings}';
  if (code && codeOn) findings.codeFindings = '${steps.explore_code.outputs.findings}';
  // Explore UI + code BEFORE playwright-test-planner so findings feed the MD plan.
  const steps: WfStep[] = [
    step('read_story', 'rv.read-user-story', { locked: true, config: { includeAttachments: true }, inputs: { storyRef: '${params.story}' }, retry: { maxAttempts: 3, backoff: 'exponential', initialDelaySec: 2, retryOn: ['transient', 'rate-limited'] }, timeoutMinutes: 5 }),
  ];
  if (ui) {
    steps.push(step('explore_ui', 'rv.explore-ui', {
      enabled: uiOn,
      mandatory: false,
      locked: mode !== 'standard',
      dependsOn: ['read_story'],
      pause: 'safe',
      config: { maxPages: 15 },
      inputs: { story: '${steps.read_story.outputs.storyArtifact}', environment: '${params.environment}' },
      timeoutMinutes: 30,
    }));
  }
  if (code) {
    steps.push(step('explore_code', 'rv.explore-code', {
      enabled: codeOn,
      mandatory: false,
      locked: mode !== 'standard',
      dependsOn: ['read_story'],
      pause: 'safe',
      config: { maxFiles: 200 },
      inputs: { story: '${steps.read_story.outputs.storyArtifact}' },
      timeoutMinutes: 30,
    }));
  }
  steps.push(
    step('consolidate', 'rv.consolidate-findings', { locked: true, dependsOn: exploreDeps, inputs: findings }),
    step('plan', 'rv.generate-test-plan', {
      locked: true,
      dependsOn: ['consolidate'],
      config: { maxScenarios: 200 },
      inputs: {
        story: '${steps.read_story.outputs.storyArtifact}',
        findings: '${steps.consolidate.outputs.combined}',
      },
      retry: { maxAttempts: 2, backoff: 'fixed', initialDelaySec: 5, retryOn: ['transient'] },
      timeoutMinutes: 30,
    }),
    step('generate_tests', 'rv.generate-tests', {
      locked: true,
      dependsOn: ['plan'],
      pause: 'safe',
      config: { language: 'javascript', maxTests: 250 },
      inputs: {
        plan: '${steps.plan.outputs.planArtifact}',
        planMarkdown: '${steps.plan.outputs.planMarkdown}',
        findings: '${steps.consolidate.outputs.combined}',
      },
      timeoutMinutes: 45,
    }),
    step('heal_tests', 'rv.heal-tests', {
      locked: true,
      dependsOn: ['generate_tests'],
      pause: 'safe',
      config: { maxFixes: 250 },
      inputs: {
        cases: '${steps.generate_tests.outputs.cases}',
        planMarkdown: '${steps.plan.outputs.planMarkdown}',
        findings: '${steps.consolidate.outputs.combined}',
      },
      timeoutMinutes: 45,
    }),
    step('publish_testcases', 'rv.publish-testcases', {
      locked: true,
      dependsOn: ['heal_tests'],
      pause: 'safe',
      inputs: { cases: '${steps.heal_tests.outputs.cases}' },
    }),
  );
  return steps;
}

const rvParams: WfParameter[] = [
  { name: 'story', type: 'work-item-ref', required: true },
  { name: 'environment', type: 'environment-ref', required: false },
  { name: 'applicationName', type: 'string', required: true },
];

function rvConnectors(browser: boolean | 'off' | 'optional', repo: boolean | 'off' | 'optional'): WfConnector[] {
  const rows = [connector('workItemSource', 'work-item', ['workitem.read', 'workitem.attachment.read'], ['workitem.search'])];
  if (browser !== 'off') rows.push(connector('browserAutomation', 'browser-automation', ['browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.wait', 'browser.evaluate', 'browser.interact', 'browser.screenshot'], [], browser === true));
  if (repo !== 'off') rows.push(connector('sourceRepo', 'source-repo', ['scm.tree.list', 'scm.file.read', 'scm.code.search', 'scm.branch.list'], [], repo === true));
  rows.push(
    connector('testManagement', 'test-management', ['tm.testcase.read'], ['tm.testcase.upsert', 'tm.execution.upsert', 'tm.execution.status.update', 'tm.attachment.upload']),
  );
  return rows;
}

function rv(key: string, name: string, summary: string, mode: 'standard' | 'ui' | 'code' | 'both', browser: boolean | 'off' | 'optional', repo: boolean | 'off' | 'optional', timeout = 120): TemplateInfo {
  return {
    key, name, type: 'requirement-validation', summary,
    definition: base(key, name, summary, 'requirement-validation', {
      parameters: rvParams,
      connectors: rvConnectors(browser, repo),
      environment: env(['development', 'qa', 'staging', 'uat']),
      execution: execution(mode === 'both' ? 2 : 2, timeout),
      approvals: [],
      policy: { capabilityDeny: ['scm.write.*', 'tm.testcase.delete'] },
      steps: rvSteps(mode),
    }),
  };
}

function rgSteps(mode: 'all' | 'selected' | 'smoke'): WfStep[] {
  const scope = mode === 'all' ? 'all-in-suite' : mode === 'smoke' ? 'regression-collection' : 'selected';
  return [
    step('select_project', 'rg.select-squash-project', { locked: true, inputs: { scope: '${params.squashScope}' } }),
    step('configure_scope', 'rg.configure-scope', { locked: mode === 'all' ? ['mode'] : mode === 'smoke' ? ['mode', 'collectionKey'] : [], dependsOn: ['select_project'], config: { mode: scope, ...(mode === 'smoke' ? { collectionKey: 'smoke' } : {}) }, inputs: { candidates: '${steps.select_project.outputs.candidates}', selection: '${params.selection}' } }),
    step('select_env', 'rg.select-environment', { locked: true, dependsOn: ['configure_scope'], inputs: { environment: '${params.environment}' } }),
    step('resolve_automation', 'rg.resolve-automation', { locked: true, dependsOn: ['select_env'], inputs: { scope: '${steps.configure_scope.outputs.scope}' } }),
    step('execute', 'rg.execute-tests', { locked: true, dependsOn: ['resolve_automation'], pause: 'safe', config: mode === 'smoke' ? { parallelism: 6, testRetries: 0 } : { parallelism: 4, testRetries: 0 }, inputs: { automation: '${steps.resolve_automation.outputs.resolved}', environment: '${steps.select_env.outputs.resolved}' }, timeoutMinutes: 60 }),
    step('update_squash', 'rg.update-squash', { locked: true, dependsOn: ['execute'], pause: 'safe', retry: { maxAttempts: 5, backoff: 'exponential', initialDelaySec: 3, retryOn: ['transient', 'rate-limited'] }, inputs: { results: '${steps.execute.outputs.results}' } }),
    step('report', 'rg.regression-report', { locked: true, dependsOn: ['update_squash'], inputs: { results: '${steps.execute.outputs.results}', sync: '${steps.update_squash.outputs.sync}' } }),
  ];
}

const rgConnectors = (): WfConnector[] => [
  connector('testManagement', 'test-management', ['tm.project.list', 'tm.campaign.list', 'tm.testcase.list', 'tm.testcase.read'], ['tm.suite.list', 'tm.execution.upsert', 'tm.execution.status.update', 'tm.attachment.upload', 'tm.tag.list']),
  connector('testRunner', 'test-runner', ['runner.test.execute', 'runner.test.list']),
];

function rg(key: string, name: string, summary: string, mode: 'all' | 'selected' | 'smoke'): TemplateInfo {
  const selection: WfParameter = mode === 'smoke'
    ? { name: 'selection', type: 'test-case-selection', required: true, pinned: { mode: 'regression-collection', collectionKey: 'smoke' } }
    : mode === 'all'
      ? { name: 'selection', type: 'test-case-selection', required: true, pinned: { mode: 'all-in-suite' } }
      : { name: 'selection', type: 'test-case-selection', required: true };
  return {
    key, name, type: 'regression-testing', summary,
    definition: base(key, name, summary, 'regression-testing', {
      parameters: [
        { name: 'squashScope', type: 'squash-scope', required: true },
        selection,
        { name: 'environment', type: 'environment-ref', required: true },
        { name: 'browser', type: 'enum', required: false, default: 'chromium' },
      ],
      connectors: rgConnectors(),
      environment: env(['qa', 'staging', 'uat', 'production']),
      execution: execution(mode === 'smoke' ? 6 : 4, mode === 'smoke' ? 45 : 240, 'continue-if-not-mandatory'),
      approvals: [{ id: 'prod-gate', gate: 'before-start', stepId: null, when: 'environment-kind:production', approverRoles: ['qa_lead', 'administrator'] }],
      policy: { capabilityDeny: ['tm.testcase.upsert', 'scm.*', 'browser.*', 'agent.*'] },
      steps: rgSteps(mode),
    }),
  };
}

export const TEMPLATES: readonly TemplateInfo[] = [
  rv('tpl-rv-standard', 'Standard Requirement Validation', 'Read a story, explore the UI (code is optional), plan an MD test plan, generate many cases, heal broken ones, and store them in Squash.', 'standard', 'optional', 'optional'),
  rv('tpl-rv-ui-only', 'UI-Only Requirement Validation', 'Explore the UI before planning. Code exploration is not offered.', 'ui', true, 'off'),
  rv('tpl-rv-code-only', 'Code-Only Requirement Validation', 'Explore the repository before planning. UI exploration is not offered.', 'code', 'off', true),
  rv('tpl-rv-ui-code', 'UI + Code Requirement Validation', 'Explore the UI and the repository before planning. Both stay on.', 'both', true, true, 180),
  rg('tpl-rg-full', 'Full Regression Suite', 'Run every automated case in a Squash suite.', 'all'),
  rg('tpl-rg-selected', 'Selected Regression Suite', 'Run the cases, suites, or collection chosen at the start.', 'selected'),
  rg('tpl-rg-smoke', 'Smoke Regression', 'Run the smoke collection with a shorter timeout.', 'smoke'),
];

export const templateDefinition = (key: string): WfDef | undefined => {
  const found = TEMPLATES.find((t) => t.key === key);
  return found ? structuredClone(found.definition) : undefined;
};
