import { describe, expect, it } from 'vitest';
import { TEMPLATES, errorsOf, templateDefinition, validateWorkflow, type BoundInstance, type WfDef } from '../src';

const bind = (def: WfDef): BoundInstance[] => def.spec.connectors.map((c) => ({
  role: c.role,
  category: c.category,
  enabled: true,
  health: 'healthy',
  accessMode: 'read_only',
  capabilities: [...c.requiredCapabilities, ...(c.optionalCapabilities ?? [])],
}));

const issues = (def: WfDef, instances = bind(def)) => validateWorkflow(def, { instances });

describe('workflow validator', () => {
  it('accepts all seven templates when their connectors can do the work', () => {
    expect(TEMPLATES).toHaveLength(7);
    for (const t of TEMPLATES) {
      const def = templateDefinition(t.key)!;
      expect(errorsOf(issues(def)), t.key).toEqual([]);
    }
  });

  it('blocks a required step that is turned off, a missing dependency, a missing capability, and a writeable repository', () => {
    const def = templateDefinition('tpl-rv-standard')!;
    def.spec.steps.find((s) => s.type === 'rv.read-user-story')!.enabled = false;
    expect(issues(def).some((i) => i.ruleId === 'V2')).toBe(true);

    const broken = templateDefinition('tpl-rv-ui-only')!;
    broken.spec.steps.find((s) => s.id === 'plan')!.dependsOn = ['missing'];
    expect(issues(broken).some((i) => i.ruleId === 'V3')).toBe(true);

    const caps = bind(templateDefinition('tpl-rv-code-only')!);
    const repo = caps.find((c) => c.role === 'sourceRepo')!;
    repo.capabilities = repo.capabilities.filter((c) => c !== 'scm.file.read');
    expect(validateWorkflow(templateDefinition('tpl-rv-code-only'), { instances: caps }).some((i) => i.ruleId === 'V4')).toBe(true);
    repo.capabilities.push('scm.file.read');
    repo.accessMode = 'read_write';
    expect(validateWorkflow(templateDefinition('tpl-rv-code-only'), { instances: caps }).some((i) => i.ruleId === 'V6')).toBe(true);
  });

  it('warns when an optional capability is missing and rejects a deny list that drops a type rule', () => {
    const def = templateDefinition('tpl-rg-smoke')!;
    const instances = bind(def).map((i) => ({ ...i, capabilities: i.capabilities.filter((c) => c !== 'tm.attachment.upload') }));
    const report = validateWorkflow(def, { instances });
    expect(errorsOf(report)).toEqual([]);
    expect(report.some((i) => i.ruleId === 'V4b')).toBe(true);

    def.spec.policy.capabilityDeny = def.spec.policy.capabilityDeny.filter((d) => d !== 'scm.*');
    expect(validateWorkflow(def, { instances: bind(def) }).some((i) => i.ruleId === 'V7')).toBe(true);

    const rv = templateDefinition('tpl-rv-standard')!;
    rv.spec.environment.production.allowed = true;
    expect(issues(rv).some((i) => i.ruleId === 'V10')).toBe(true);
    rv.spec.steps[0]!.retry = { maxAttempts: 9 };
    expect(issues(rv).some((i) => i.ruleId === 'V11')).toBe(true);
  });

  it('tells the user to switch Squash on, and does not judge the steps that run later', () => {
    const def = templateDefinition('tpl-rv-ui-code')!;
    const instances = bind(def).map((i) => i.role === 'testManagement' ? { ...i, enabled: false, health: 'healthy' as const, capabilities: ['tm.testcase.list'] } : i);
    const report = validateWorkflow(def, { instances });
    const errors = errorsOf(report);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/Squash connector is switched off/);
    expect(errors.some((i) => i.message.includes('cannot read test cases'))).toBe(false);
  });

  it('publishes against a read-only Squash when the work-item connector can read a story and its attachments', () => {
    const def = templateDefinition('tpl-rv-standard')!;
    const work = def.spec.connectors.find((c) => c.role === 'workItemSource')!;
    work.requiredCapabilities = ['workitem.read', 'workitem.attachment.read', 'workitem.search'];
    const tm = def.spec.connectors.find((c) => c.role === 'testManagement')!;
    tm.requiredCapabilities = ['tm.testcase.upsert', 'tm.testcase.read', 'tm.execution.upsert', 'tm.execution.status.update'];
    const instances = bind(def).map((i) => {
      if (i.role === 'workItemSource') return { ...i, capabilities: ['workitem.read'] };
      if (i.role === 'testManagement') return { ...i, capabilities: ['tm.testcase.read'] };
      return i;
    });
    const report = validateWorkflow(def, { instances });
    expect(errorsOf(report)).toEqual([]);
    expect(report.some((i) => i.severity === 'warning' && i.message.includes('tm.testcase.upsert'))).toBe(true);
    expect(report.some((i) => i.severity === 'warning' && i.message.includes('same token'))).toBe(true);

    const regression = templateDefinition('tpl-rg-full')!;
    const rg = bind(regression).map((i) => i.role === 'testManagement' ? { ...i, capabilities: ['tm.project.list', 'tm.campaign.list', 'tm.testcase.list', 'tm.testcase.read'] } : i);
    expect(errorsOf(validateWorkflow(regression, { instances: rg }))).toEqual([]);
  });
});
