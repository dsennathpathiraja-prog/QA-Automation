import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { CapabilityDescriptor, ConnectorCategory } from './types';

export class CapabilityRegistry {
  private readonly byId = new Map<string, CapabilityDescriptor>();

  register(d: CapabilityDescriptor): void {
    if (this.byId.has(d.id)) throw new Error(`Capability already registered: ${d.id}`);
    // Source repositories are read-only by construction: there is no vocabulary for writes.
    if (d.category === 'source-repo' && d.access !== 'read') {
      throw new Error(`Capability ${d.id}: category 'source-repo' cannot declare write capabilities`);
    }
    if (d.access === 'write' && d.idempotent === undefined) {
      throw new Error(`Capability ${d.id}: write capabilities must declare an idempotency mode`);
    }
    if (!d.id.includes('.')) throw new Error(`Capability id must be namespaced: ${d.id}`);
    this.byId.set(d.id, d);
  }

  get(id: string): CapabilityDescriptor {
    const d = this.byId.get(id);
    if (!d) throw new PlatformError('unsupported', `Unknown capability: ${id}`);
    return d;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  all(): CapabilityDescriptor[] {
    return [...this.byId.values()];
  }

  byCategory(category: ConnectorCategory): CapabilityDescriptor[] {
    return this.all().filter((d) => d.category === category);
  }
}

const str = z.string();
const opt = <T extends z.ZodTypeAny>(t: T) => t.optional();
const page = { cursor: opt(str), limit: opt(z.number().int().positive().max(200)) };

const WorkItem = z.object({
  id: str,
  title: str,
  type: opt(str),
  state: opt(str),
  description: opt(str),
  acceptanceCriteria: opt(str),
  businessRules: opt(z.array(str)),
  dependencies: opt(z.array(str)),
  attachments: opt(z.array(z.object({ id: str, name: str, mimeType: opt(str), sizeBytes: opt(z.number()) }))),
  url: opt(str),
});

const Named = z.object({ id: str, name: str });
const list = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: opt(str) });
const TestCase = z.object({
  id: str,
  name: str,
  reference: opt(str),
  suite: opt(str),
  tags: opt(z.array(str)),
  automated: opt(z.boolean()),
  lastResult: opt(str),
  kind: opt(z.enum(['classic', 'scripted', 'keyword', 'exploratory'])),
  description: opt(str),
  prerequisite: opt(str),
  importance: opt(str),
  status: opt(str),
  script: opt(str),
  steps: opt(z.array(z.object({ action: str, expected: opt(str) }))),
  customFields: opt(z.record(str)),
  lastModifiedOn: opt(str),
});
const Requirement = z.object({
  id: str,
  name: str,
  reference: opt(str),
  versionNumber: opt(z.number()),
  status: opt(str),
  criticality: opt(str),
  category: opt(str),
  description: opt(str),
  tags: opt(z.array(str)),
  verifyingTestCaseIds: opt(z.array(str)),
  customFields: opt(z.record(str)),
  lastModifiedOn: opt(str),
});
const ExecutionRecord = z.object({
  id: str,
  status: str,
  executedOn: opt(str),
  executedBy: opt(str),
  path: opt(str),
  issueCount: opt(z.number()),
});

type Def = Omit<CapabilityDescriptor, 'version'> & { version?: number };

export function defineCapabilities(): CapabilityDescriptor[] {
  const c = (d: Def): CapabilityDescriptor => ({ version: 1, ...d });
  return [
    // work-item (read only)
    c({ id: 'workitem.project.list', category: 'work-item', access: 'read', risk: 'low', input: z.object(page), output: list(Named) }),
    c({ id: 'workitem.search', category: 'work-item', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), query: str, ...page }), output: list(WorkItem.pick({ id: true, title: true, type: true, state: true })) }),
    c({ id: 'workitem.read', category: 'work-item', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), id: str }), output: WorkItem }),
    c({ id: 'workitem.attachment.read', category: 'work-item', access: 'read', risk: 'low', constraints: ['scope', 'size.max'], input: z.object({ workItemId: str, attachmentId: str }), output: z.object({ name: str, mimeType: opt(str), contentBase64: str }) }),

    // source-repo (read only, enforced by registry)
    c({ id: 'scm.org.list', category: 'source-repo', access: 'read', risk: 'low', input: z.object(page), output: list(Named) }),
    c({ id: 'scm.repo.list', category: 'source-repo', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ org: opt(str), ...page }), output: list(Named) }),
    c({ id: 'scm.branch.list', category: 'source-repo', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ org: opt(str), repo: str, ...page }), output: list(Named) }),
    c({ id: 'scm.tree.list', category: 'source-repo', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ repo: str, branch: opt(str), path: opt(str) }), output: z.object({ entries: z.array(z.object({ path: str, type: z.enum(['file', 'dir']), sizeBytes: opt(z.number()) })) }) }),
    c({ id: 'scm.file.read', category: 'source-repo', access: 'read', risk: 'low', constraints: ['scope', 'size.max'], input: z.object({ repo: str, branch: opt(str), path: str }), output: z.object({ path: str, content: str, truncated: z.boolean() }) }),
    c({ id: 'scm.code.search', category: 'source-repo', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ repo: str, branch: opt(str), query: str, ...page }), output: list(z.object({ path: str, snippet: str })) }),
    c({ id: 'scm.commit.list', category: 'source-repo', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ repo: str, branch: opt(str), ...page }), output: list(z.object({ sha: str, message: str, author: opt(str) })) }),
    c({ id: 'scm.permissions.inspect', category: 'source-repo', access: 'read', risk: 'low', input: z.object({}), output: z.object({ granted: z.array(str), writePermissionsDetected: z.array(str) }) }),

    // browser-automation
    c({ id: 'browser.session.open', category: 'browser-automation', access: 'read', risk: 'low', input: z.object({ viewport: opt(z.object({ width: z.number(), height: z.number() })) }), output: z.object({ sessionId: str }) }),
    c({ id: 'browser.navigate', category: 'browser-automation', access: 'read', risk: 'medium', constraints: ['browser.origin-allowlist'], input: z.object({ sessionId: str, url: str }), output: z.object({ finalUrl: str, status: opt(z.number()) }) }),
    c({ id: 'browser.snapshot', category: 'browser-automation', access: 'read', risk: 'low', constraints: ['size.max'], input: z.object({ sessionId: str }), output: z.object({ accessibilityTree: str, url: str }) }),
    c({ id: 'browser.interact', category: 'browser-automation', access: 'write', idempotent: 'natural', risk: 'medium', constraints: ['browser.origin-allowlist'], input: z.object({ sessionId: str, action: z.enum(['click', 'type', 'select', 'press']), target: str, value: opt(str) }), output: z.object({ ok: z.boolean() }) }),
    c({ id: 'browser.screenshot', category: 'browser-automation', access: 'read', risk: 'low', input: z.object({ sessionId: str, fullPage: opt(z.boolean()) }), output: z.object({ artifactBase64: str }) }),
    c({ id: 'browser.network.observe', category: 'browser-automation', access: 'read', risk: 'low', input: z.object({ sessionId: str }), output: z.object({ requests: z.array(z.object({ url: str, status: opt(z.number()) })) }) }),
    c({ id: 'browser.session.close', category: 'browser-automation', access: 'read', risk: 'low', input: z.object({ sessionId: str }), output: z.object({ ok: z.boolean() }) }),

    // test-management
    c({ id: 'tm.capabilities.probe', category: 'test-management', access: 'read', risk: 'low', input: z.object({}), output: z.object({ version: opt(str), capabilities: z.array(z.object({ capability: str, support: z.enum(['supported', 'partial', 'unsupported']), reason: opt(str) })) }) }),
    c({ id: 'tm.project.list', category: 'test-management', access: 'read', risk: 'low', input: z.object(page), output: list(Named) }),
    c({ id: 'tm.testcase.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), suite: opt(str), ...page }), output: list(TestCase) }),
    c({ id: 'tm.testcase.read', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), id: str }), output: TestCase }),
    c({ id: 'tm.testcase.search', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), reference: opt(str), query: opt(str), ...page }), output: list(TestCase) }),
    c({ id: 'tm.requirement.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), ...page }), output: list(Requirement.pick({ id: true, name: true, reference: true })) }),
    c({ id: 'tm.requirement.read', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), id: str }), output: Requirement }),
    c({ id: 'tm.execution.history', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), testCaseId: str, ...page }), output: list(ExecutionRecord) }),
    c({ id: 'tm.suite.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), ...page }), output: list(Named) }),
    c({ id: 'tm.campaign.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), ...page }), output: list(Named) }),
    c({ id: 'tm.iteration.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), campaign: opt(str), ...page }), output: list(Named) }),
    c({ id: 'tm.tag.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str) }), output: list(Named) }),
    c({ id: 'tm.customfield.list', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str) }), output: list(Named) }),
    c({ id: 'tm.customfield.read', category: 'test-management', access: 'read', risk: 'low', constraints: ['scope'], input: z.object({ project: opt(str), entityId: str }), output: z.object({ values: z.record(str) }) }),
    c({ id: 'tm.testcase.upsert', category: 'test-management', access: 'write', idempotent: 'key-required', risk: 'medium', constraints: ['scope'], input: z.object({ project: opt(str), reference: str, name: str, description: opt(str), steps: opt(z.array(z.object({ action: str, expected: opt(str) }))), tags: opt(z.array(str)) }), output: z.object({ id: str, created: z.boolean(), projectId: opt(str) }) }),
    c({ id: 'tm.campaign.upsert', category: 'test-management', access: 'write', idempotent: 'key-required', risk: 'medium', constraints: ['scope'], input: z.object({ project: opt(str), name: str }), output: z.object({ id: str, created: z.boolean() }) }),
    c({ id: 'tm.iteration.upsert', category: 'test-management', access: 'write', idempotent: 'key-required', risk: 'medium', constraints: ['scope'], input: z.object({ project: opt(str), campaignId: str, name: str }), output: z.object({ id: str, created: z.boolean() }) }),
    c({ id: 'tm.customfield.update', category: 'test-management', access: 'write', idempotent: 'natural', risk: 'medium', constraints: ['scope'], input: z.object({ project: opt(str), entityId: str, values: z.record(str) }), output: z.object({ ok: z.boolean() }) }),
    c({ id: 'tm.execution.upsert', category: 'test-management', access: 'write', idempotent: 'key-required', risk: 'medium', constraints: ['scope'], input: z.object({ project: opt(str), iterationId: opt(str), testCaseId: str }), output: z.object({ id: str, created: z.boolean() }) }),
    c({ id: 'tm.execution.status.update', category: 'test-management', access: 'write', idempotent: 'natural', risk: 'medium', constraints: ['scope'], input: z.object({ project: opt(str), executionId: str, status: str, actualResult: opt(str) }), output: z.object({ ok: z.boolean() }) }),
    c({ id: 'tm.attachment.upload', category: 'test-management', access: 'write', idempotent: 'key-required', risk: 'medium', constraints: ['scope', 'size.max'], input: z.object({ project: opt(str), entityType: z.enum(['execution', 'testcase']), entityId: str, name: str, contentBase64: str, sha256: str }), output: z.object({ id: str }) }),

    // test-runner (managed)
    c({ id: 'runner.test.list', category: 'test-runner', access: 'read', risk: 'low', input: z.object({ workspaceRevision: str, application: str }), output: z.object({ tests: z.array(z.object({ file: str, testId: str })) }) }),
    c({ id: 'runner.test.execute', category: 'test-runner', access: 'write', idempotent: 'key-required', risk: 'high', input: z.object({ bundleRef: str, environmentId: str, selection: z.array(str), parallelism: z.number().int().positive() }), output: z.object({ runId: str }) }),
  ];
}

export function createDefaultCapabilityRegistry(): CapabilityRegistry {
  const r = new CapabilityRegistry();
  for (const d of defineCapabilities()) r.register(d);
  return r;
}
