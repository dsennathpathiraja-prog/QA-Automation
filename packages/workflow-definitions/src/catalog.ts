import type { WorkflowKind } from './types';

export interface StepRole {
  role: string;
  required: readonly string[];
}

export interface StepType {
  type: string;
  workflow: WorkflowKind;
  mandatory: boolean;
  mandatoryIfAnyEnabled?: readonly string[];
  after: readonly string[];
  pause: 'safe' | 'boundary' | 'never';
  roles: readonly StepRole[];
}

const rv = (type: string, extra: Omit<StepType, 'type' | 'workflow'>): StepType => ({ type, workflow: 'requirement-validation', ...extra });
const rg = (type: string, extra: Omit<StepType, 'type' | 'workflow'>): StepType => ({ type, workflow: 'regression-testing', ...extra });

export const STEP_TYPES: readonly StepType[] = [
  rv('rv.read-user-story', { mandatory: true, after: [], pause: 'boundary', roles: [{ role: 'workItemSource', required: ['workitem.read', 'workitem.attachment.read'] }] }),
  rv('rv.generate-test-plan', { mandatory: true, after: ['rv.read-user-story'], pause: 'boundary', roles: [] }),
  rv('rv.explore-ui', { mandatory: false, after: ['rv.generate-test-plan'], pause: 'safe', roles: [{ role: 'browserAutomation', required: ['browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.interact', 'browser.screenshot'] }] }),
  rv('rv.explore-code', { mandatory: false, after: ['rv.generate-test-plan'], pause: 'safe', roles: [{ role: 'sourceRepo', required: ['scm.tree.list', 'scm.file.read', 'scm.code.search', 'scm.branch.list'] }] }),
  rv('rv.consolidate-findings', { mandatory: false, mandatoryIfAnyEnabled: ['rv.explore-ui', 'rv.explore-code'], after: ['rv.explore-ui', 'rv.explore-code'], pause: 'boundary', roles: [] }),
  rv('rv.generate-tests', { mandatory: true, after: ['rv.consolidate-findings'], pause: 'safe', roles: [] }),
  rv('rv.publish-testcases', { mandatory: true, after: ['rv.generate-tests'], pause: 'safe', roles: [{ role: 'testManagement', required: ['tm.testcase.read'] }] }),
  rv('rv.execute-tests', { mandatory: true, after: ['rv.publish-testcases'], pause: 'safe', roles: [{ role: 'testRunner', required: ['runner.test.execute'] }] }),
  rv('rv.sync-results', { mandatory: true, after: ['rv.execute-tests'], pause: 'safe', roles: [{ role: 'testManagement', required: ['tm.testcase.read'] }] }),
  rv('rv.qa-report', { mandatory: true, after: ['rv.sync-results'], pause: 'boundary', roles: [] }),
  rg('rg.select-squash-project', { mandatory: true, after: [], pause: 'boundary', roles: [{ role: 'testManagement', required: ['tm.project.list', 'tm.testcase.list'] }] }),
  rg('rg.configure-scope', { mandatory: true, after: ['rg.select-squash-project'], pause: 'boundary', roles: [{ role: 'testManagement', required: ['tm.testcase.read'] }] }),
  rg('rg.select-environment', { mandatory: true, after: ['rg.configure-scope'], pause: 'boundary', roles: [] }),
  rg('rg.resolve-automation', { mandatory: true, after: ['rg.select-environment'], pause: 'boundary', roles: [] }),
  rg('rg.execute-tests', { mandatory: true, after: ['rg.resolve-automation'], pause: 'safe', roles: [{ role: 'testRunner', required: ['runner.test.execute'] }] }),
  rg('rg.update-squash', { mandatory: true, after: ['rg.execute-tests'], pause: 'safe', roles: [{ role: 'testManagement', required: ['tm.testcase.read'] }] }),
  rg('rg.regression-report', { mandatory: true, after: ['rg.update-squash'], pause: 'boundary', roles: [] }),
];

export const TYPE_SPECS: Record<WorkflowKind, { deny: readonly string[]; atLeastOneOf: readonly string[] }> = {
  'requirement-validation': { deny: ['scm.write.*'], atLeastOneOf: ['rv.explore-ui', 'rv.explore-code'] },
  'regression-testing': { deny: ['tm.testcase.upsert', 'scm.*', 'browser.*', 'agent.*'], atLeastOneOf: [] },
};

export const stepType = (type: string) => STEP_TYPES.find((s) => s.type === type);
export const stepsFor = (workflow: WorkflowKind) => STEP_TYPES.filter((s) => s.workflow === workflow);
