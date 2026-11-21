import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { ActorRef } from './connector-service';
import type { AuditSink } from './ports';

export type WorkItemRunStatus = 'prepared' | 'queued' | 'running' | 'completed' | 'failed';
export type CaseRunStatus = 'Passed' | 'Failed' | 'Blocked' | 'Skipped';
export type TestCaseKind = 'positive' | 'negative' | 'edge';
export type TestCasePriority = 'high' | 'medium' | 'low';

export interface TestCaseRecord {
  id: string;
  key: string;
  name: string;
  summary: string;
  workItem: string;
  kind: TestCaseKind;
  priority: TestCasePriority;
  currentVersion: number;
  updatedAt: Date;
}

export interface TestCaseVersionRecord {
  version: number;
  steps: string;
  expected: string;
  createdAt: Date;
}

export interface TestCollectionRecord {
  id: string;
  name: string;
  description: string;
  size: number;
}

export interface CollectionCaseRecord {
  id: string;
  name: string;
  version: number;
  position: number;
  kind: TestCaseKind;
  priority: TestCasePriority;
}

export interface WorkItemCaseResultRecord {
  id: string;
  testCaseId: string;
  name: string;
  status: CaseRunStatus;
  message: string;
  screenshotPng?: string;
  squashExecutionId?: string;
}

export interface TestCaseInsert {
  id: string;
  key: string;
  name: string;
  summary: string;
  workItem: string;
  steps: string;
  expected: string;
  kind: TestCaseKind;
  priority: TestCasePriority;
}

export interface TestCaseRepository {
  list(): Promise<TestCaseRecord[]>;
  get(id: string): Promise<TestCaseRecord | undefined>;
  findKey(key: string): Promise<TestCaseRecord | undefined>;
  insert(row: TestCaseInsert): Promise<TestCaseRecord>;
  current(id: string): Promise<TestCaseVersionRecord | undefined>;
  versions(id: string): Promise<TestCaseVersionRecord[]>;
  saveVersion(id: string, version: number, steps: string, expected: string, summary: string): Promise<TestCaseRecord>;
  saveSummary(id: string, summary: string): Promise<TestCaseRecord>;
  /** Updates name, key, kind, and/or priority without bumping the case version. */
  saveIdentity(id: string, patch: { name?: string; key?: string; kind?: TestCaseKind; priority?: TestCasePriority }): Promise<TestCaseRecord>;
  softDelete(id: string): Promise<boolean>;
  /** Soft-deletes every active collection and case on the platform. Squash is not touched. */
  softDeleteAllPlatform(): Promise<{ cases: number; collections: number }>;
  listCollections(): Promise<TestCollectionRecord[]>;
  getCollection(id: string): Promise<{ id: string; name: string; description: string; cases: CollectionCaseRecord[] } | undefined>;
  insertCollection(row: { id: string; name: string; description: string }): Promise<TestCollectionRecord>;
  addCase(collectionId: string, testCaseId: string): Promise<'added' | 'exists'>;
  removeCase(collectionId: string, testCaseId: string): Promise<boolean>;
  softDeleteCollection(id: string): Promise<boolean>;
  listWorkItemRuns(): Promise<WorkItemRunRecord[]>;
  getWorkItemRun(id: string): Promise<WorkItemRunRecord | undefined>;
  insertWorkItemRun(row: { id: string; workItem: string; environmentId: string; environmentName: string; caseCount: number }): Promise<WorkItemRunRecord>;
  updateWorkItemRun(id: string, patch: { status: WorkItemRunStatus; squashSync?: string; finishedAt?: Date }): Promise<WorkItemRunRecord>;
  claimQueuedWorkItemRun(): Promise<WorkItemRunRecord | undefined>;
  replaceCaseResults(executionId: string, results: Array<{ id: string; testCaseId: string; name: string; status: CaseRunStatus; message: string; screenshotPng?: string; squashExecutionId?: string }>): Promise<void>;
  listCaseResults(executionId: string): Promise<WorkItemCaseResultRecord[]>;
  getCaseResult(executionId: string, testCaseId: string): Promise<WorkItemCaseResultRecord | undefined>;
}

export interface WorkItemRunRecord {
  id: string;
  workItem: string;
  environmentId: string;
  environmentName: string;
  caseCount: number;
  status: WorkItemRunStatus;
  squashSync?: string;
  createdAt: Date;
  finishedAt?: Date;
}

export interface TestCaseView {
  id: string;
  key: string;
  name: string;
  summary: string;
  workItem: string;
  kind: TestCaseKind;
  priority: TestCasePriority;
  version: number;
  steps: string;
  expected: string;
  updatedAt: string;
}

export interface TestCaseListItem {
  id: string;
  key: string;
  name: string;
  summary: string;
  workItem: string;
  kind: TestCaseKind;
  priority: TestCasePriority;
  version: number;
  updatedAt: string;
}

/** Infer kind from PR #9-style case titles when the planner did not send one. */
export function kindFromName(name: string): TestCaseKind {
  if (/^negative\s*:/i.test(name)) return 'negative';
  if (/^edge\s*:/i.test(name)) return 'edge';
  return 'positive';
}

export function priorityForKind(kind: TestCaseKind): TestCasePriority {
  if (kind === 'negative') return 'high';
  if (kind === 'edge') return 'low';
  return 'medium';
}

const itemOf = (r: TestCaseRecord): TestCaseListItem => ({
  id: r.id,
  key: r.key,
  name: r.name,
  summary: r.summary,
  workItem: r.workItem,
  kind: r.kind,
  priority: r.priority,
  version: r.currentVersion,
  updatedAt: r.updatedAt.toISOString(),
});

const runOf = (row: WorkItemRunRecord, results?: WorkItemCaseResultRecord[]) => ({
  id: row.id,
  workItem: row.workItem,
  environmentId: row.environmentId,
  environmentName: row.environmentName,
  caseCount: row.caseCount,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString(),
  squashSync: row.squashSync,
  results: results?.map((r) => ({
    id: r.id,
    testCaseId: r.testCaseId,
    name: r.name,
    status: r.status,
    message: r.message,
    hasScreenshot: Boolean(r.screenshotPng),
    squashExecutionId: r.squashExecutionId,
  })),
});

export class TestCaseService {
  constructor(private readonly d: { cases: TestCaseRepository; audit: AuditSink }) {}

  async list(): Promise<TestCaseListItem[]> {
    return (await this.d.cases.list()).map(itemOf);
  }

  async get(id: string): Promise<TestCaseView> {
    const row = await this.require(id);
    const version = await this.d.cases.current(id);
    if (!version) throw new PlatformError('not-found', 'Test case not found');
    return { ...itemOf(row), steps: version.steps, expected: version.expected };
  }

  async versions(id: string): Promise<Array<{ version: number; steps: string; expected: string; createdAt: string }>> {
    await this.require(id);
    return (await this.d.cases.versions(id)).map((r) => ({ version: r.version, steps: r.steps, expected: r.expected, createdAt: r.createdAt.toISOString() }));
  }

  async create(actor: ActorRef, input: { name: string; summary?: string; steps: string; expected: string; workItem?: string; kind?: TestCaseKind; priority?: TestCasePriority }): Promise<TestCaseView> {
    const name = this.name(input.name);
    const workItem = this.summary(input.workItem ?? '');
    const key = this.key(workItem ? `${workItem} ${name}` : name);
    if (await this.d.cases.findKey(key)) throw new PlatformError('conflict', 'A test case with that name already exists.');
    const summary = this.summary(input.summary ?? '');
    const steps = this.steps(input.steps);
    const expected = this.expected(input.expected);
    const kind = this.kind(input.kind ?? kindFromName(name));
    const priority = this.priority(input.priority ?? priorityForKind(kind));
    const row = await this.d.cases.insert({ id: randomUUID(), key, name, summary, workItem, steps, expected, kind, priority });
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.create', subjectType: 'test_case', subjectId: row.id, detail: { key } });
    return this.get(row.id);
  }

  async revise(actor: ActorRef, id: string, input: { summary?: string; steps: string; expected: string }): Promise<TestCaseView> {
    const current = await this.get(id);
    const summary = input.summary === undefined ? current.summary : this.summary(input.summary);
    const steps = this.steps(input.steps);
    const expected = this.expected(input.expected);
    if (steps === current.steps && expected === current.expected && summary === current.summary) return current;
    if (steps === current.steps && expected === current.expected) {
      await this.d.cases.saveSummary(id, summary);
    } else {
      await this.d.cases.saveVersion(id, current.version + 1, steps, expected, summary);
    }
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.revise', subjectType: 'test_case', subjectId: id, detail: { version: steps === current.steps && expected === current.expected ? current.version : current.version + 1 } });
    return this.get(id);
  }

  /** Soft-deletes a case and removes it from every collection. Squash is left alone. */
  async remove(actor: ActorRef, id: string): Promise<void> {
    await this.require(id);
    const deleted = await this.d.cases.softDelete(id);
    if (!deleted) throw new PlatformError('not-found', 'Test case not found');
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.delete', subjectType: 'test_case', subjectId: id });
  }

  /**
   * Soft-deletes every platform collection and case so a local rebuild can start empty.
   * Squash copies are never wiped by this call (wipeSquash is rejected if true).
   */
  async resetPlatform(actor: ActorRef, input: { confirm: string; wipeSquash?: boolean }): Promise<{ collectionsCleared: number; casesCleared: number; squashWiped: false }> {
    if (input.confirm !== 'RESET_PLATFORM_CASES') {
      throw new PlatformError('validation', 'Confirm with RESET_PLATFORM_CASES to clear platform test cases.');
    }
    if (input.wipeSquash) {
      throw new PlatformError('validation', 'Squash wipe is not supported from this endpoint. Clear Squash manually if you need that.');
    }
    const result = await this.d.cases.softDeleteAllPlatform();
    await this.d.audit.append({
      actorId: actor.id,
      action: 'testcase.reset',
      subjectType: 'test_case',
      subjectId: 'platform',
      detail: { collectionsCleared: result.collections, casesCleared: result.cases, squashWiped: false },
    });
    return { collectionsCleared: result.collections, casesCleared: result.cases, squashWiped: false };
  }

  async collections() {
    return this.d.cases.listCollections();
  }

  async collection(id: string) {
    const row = await this.d.cases.getCollection(id);
    if (!row) throw new PlatformError('not-found', 'Collection not found');
    return row;
  }

  async createCollection(actor: ActorRef, input: { name: string; description?: string }) {
    const name = this.name(input.name);
    const description = this.summary(input.description ?? '');
    const existing = (await this.d.cases.listCollections()).find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) throw new PlatformError('conflict', 'A collection with that name already exists.');
    const row = await this.d.cases.insertCollection({ id: randomUUID(), name, description });
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.collection.create', subjectType: 'test_collection', subjectId: row.id, detail: { name } });
    return row;
  }

  /**
   * Soft-deletes a collection and its member cases on the platform.
   * Squash (or other TM) copies are not deleted.
   */
  async removeCollection(actor: ActorRef, id: string): Promise<void> {
    const row = await this.collection(id);
    const deleted = await this.d.cases.softDeleteCollection(id);
    if (!deleted) throw new PlatformError('not-found', 'Collection not found');
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.collection.delete', subjectType: 'test_collection', subjectId: id, detail: { name: row.name, caseCount: row.cases.length } });
  }

  async addToCollection(actor: ActorRef, collectionId: string, testCaseId: string) {
    await this.collection(collectionId);
    await this.require(testCaseId);
    const added = await this.d.cases.addCase(collectionId, testCaseId);
    if (added === 'exists') throw new PlatformError('conflict', 'That case is already in this collection.');
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.collection.add', subjectType: 'test_collection', subjectId: collectionId, detail: { testCaseId } });
    return this.collection(collectionId);
  }

  /**
   * Upserts a generated case under a collection named for its work item.
   * Scenario identity is `reference` (same key Squash uses as automated_test_reference).
   * Re-running the same work item with the same reference updates the existing case instead of inserting a duplicate.
   */
  async fileUnderWorkItem(actor: ActorRef, input: {
    name: string;
    summary?: string;
    steps: string;
    expected: string;
    workItem?: string;
    reference?: string;
    kind?: TestCaseKind;
    priority?: TestCasePriority;
  }): Promise<void> {
    const workItem = this.summary(input.workItem ?? '');
    if (!workItem) throw new PlatformError('validation', 'A generated case needs a work item.');
    const name = this.name(input.name);
    const reference = this.reference(input.reference ?? '');
    const scenarioKey = reference ? this.key(reference) : this.key(`${workItem} ${name}`);
    const legacyKey = this.key(`${workItem} ${name}`);
    const kind = this.kind(input.kind ?? kindFromName(name));
    const priority = this.priority(input.priority ?? priorityForKind(kind));
    const existing = (await this.d.cases.findKey(scenarioKey)) ?? (reference && scenarioKey !== legacyKey ? await this.d.cases.findKey(legacyKey) : undefined);
    let id: string;
    if (existing) {
      id = existing.id;
      const identity: { name?: string; key?: string; kind?: TestCaseKind; priority?: TestCasePriority } = {};
      if (existing.name !== name) identity.name = name;
      if (existing.key !== scenarioKey) identity.key = scenarioKey;
      if (existing.kind !== kind) identity.kind = kind;
      if (existing.priority !== priority) identity.priority = priority;
      if (Object.keys(identity).length > 0) await this.d.cases.saveIdentity(id, identity);
      await this.revise(actor, id, { summary: input.summary, steps: input.steps, expected: input.expected });
    } else {
      const summary = this.summary(input.summary ?? '');
      const steps = this.steps(input.steps);
      const expected = this.expected(input.expected);
      try {
        const row = await this.d.cases.insert({ id: randomUUID(), key: scenarioKey, name, summary, workItem, steps, expected, kind, priority });
        id = row.id;
        await this.d.audit.append({ actorId: actor.id, action: 'testcase.create', subjectType: 'test_case', subjectId: id, detail: { key: scenarioKey, reference: reference || undefined, kind, priority } });
      } catch (e) {
        if (!(e instanceof PlatformError) || e.errorClass !== 'conflict') throw e;
        const raced = (await this.d.cases.findKey(scenarioKey)) ?? (await this.d.cases.findKey(legacyKey));
        if (!raced) throw e;
        id = raced.id;
        const identity: { name?: string; key?: string; kind?: TestCaseKind; priority?: TestCasePriority } = {};
        if (raced.name !== name) identity.name = name;
        if (raced.key !== scenarioKey) identity.key = scenarioKey;
        if (raced.kind !== kind) identity.kind = kind;
        if (raced.priority !== priority) identity.priority = priority;
        if (Object.keys(identity).length > 0) await this.d.cases.saveIdentity(id, identity);
        await this.revise(actor, id, { summary: input.summary, steps: input.steps, expected: input.expected });
      }
    }
    const collection = await this.ensureWorkItemCollection(actor, workItem.slice(0, 120));
    await this.d.cases.addCase(collection.id, id);
  }

  async executionBoard() {
    // Align with Test Cases collections: only live members of a live work-item collection count
    // (soft-deleted cases and orphans removed from a collection must not appear here).
    const workItems: { workItem: string; caseCount: number }[] = [];
    for (const collection of await this.d.cases.listCollections()) {
      if (collection.size <= 0) continue;
      workItems.push({ workItem: collection.name, caseCount: collection.size });
    }
    workItems.sort((a, b) => a.workItem.localeCompare(b.workItem));
    const items = [];
    for (const row of await this.d.cases.listWorkItemRuns()) {
      const results = row.status === 'prepared' || row.status === 'queued' ? undefined : await this.d.cases.listCaseResults(row.id);
      items.push(runOf(row, results));
    }
    return { workItems, items };
  }

  async getWorkItemExecution(id: string) {
    const row = await this.d.cases.getWorkItemRun(id);
    if (!row) throw new PlatformError('not-found', 'Work item execution not found');
    const results = await this.d.cases.listCaseResults(id);
    return runOf(row, results);
  }

  async startWorkItemExecution(actor: ActorRef, input: { workItem: string; environmentId: string; environmentName: string }) {
    const workItem = this.summary(input.workItem);
    if (!workItem) throw new PlatformError('validation', 'Choose a work item.');
    const caseCount = (await this.casesForWorkItem(workItem)).length;
    if (caseCount === 0) throw new PlatformError('validation', 'That work item has no test cases.');
    const row = await this.d.cases.insertWorkItemRun({ id: randomUUID(), workItem, environmentId: input.environmentId, environmentName: input.environmentName, caseCount });
    await this.d.audit.append({ actorId: actor.id, action: 'workitem.execution.prepare', subjectType: 'work_item_execution', subjectId: row.id, detail: { workItem, environmentId: input.environmentId, caseCount } });
    return runOf(row);
  }

  /** Queues a prepared row so the worker runs its cases through the Playwright runner. */
  async queueWorkItemExecution(actor: ActorRef, id: string) {
    const row = await this.d.cases.getWorkItemRun(id);
    if (!row) throw new PlatformError('not-found', 'Work item execution not found');
    if (row.status !== 'prepared' && row.status !== 'failed') throw new PlatformError('conflict', 'That execution is already running or finished.');
    const updated = await this.d.cases.updateWorkItemRun(id, { status: 'queued' });
    await this.d.audit.append({ actorId: actor.id, action: 'workitem.execution.queue', subjectType: 'work_item_execution', subjectId: id, detail: { workItem: row.workItem } });
    return runOf(updated);
  }

  async claimQueuedWorkItemExecution() {
    return this.d.cases.claimQueuedWorkItemRun();
  }

  async completeWorkItemExecution(id: string, input: {
    status: 'completed' | 'failed';
    squashSync?: string;
    results: Array<{ testCaseId: string; name: string; status: CaseRunStatus; message: string; screenshotPng?: string; squashExecutionId?: string }>;
  }) {
    await this.d.cases.replaceCaseResults(id, input.results.map((r) => ({ id: randomUUID(), ...r })));
    const updated = await this.d.cases.updateWorkItemRun(id, { status: input.status, squashSync: input.squashSync, finishedAt: new Date() });
    return runOf(updated, await this.d.cases.listCaseResults(id));
  }

  async caseScreenshot(executionId: string, testCaseId: string) {
    const row = await this.d.cases.getCaseResult(executionId, testCaseId);
    if (!row?.screenshotPng) throw new PlatformError('not-found', 'Screenshot not found');
    return { testCaseId: row.testCaseId, name: row.name, contentType: 'image/png' as const, pngBase64: row.screenshotPng };
  }

  /** Live cases that belong to the work-item collection (excludes soft-deleted and uncollected orphans). */
  async casesForWorkItem(workItem: string) {
    const wanted = this.summary(workItem).toLowerCase();
    if (!wanted) return [];
    const collection = (await this.d.cases.listCollections()).find((c) => c.name.toLowerCase() === wanted);
    if (!collection) return [];
    const detail = await this.d.cases.getCollection(collection.id);
    if (!detail) return [];
    const out: TestCaseView[] = [];
    for (const member of detail.cases) {
      const view = await this.get(member.id).catch(() => undefined);
      if (view) out.push(view);
    }
    return out;
  }

  private async ensureWorkItemCollection(actor: ActorRef, workItem: string) {
    const named = async () => (await this.d.cases.listCollections()).find((c) => c.name.toLowerCase() === workItem.toLowerCase());
    const found = await named();
    if (found) return found;
    try {
      return await this.createCollection(actor, { name: workItem, description: `Cases generated for ${workItem}` });
    } catch (e) {
      if (!(e instanceof PlatformError) || e.errorClass !== 'conflict') throw e;
      const again = await named();
      if (!again) throw e;
      return again;
    }
  }

  async removeFromCollection(actor: ActorRef, collectionId: string, testCaseId: string) {
    await this.collection(collectionId);
    const removed = await this.d.cases.removeCase(collectionId, testCaseId);
    if (!removed) throw new PlatformError('not-found', 'That case is not in this collection.');
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.collection.remove', subjectType: 'test_collection', subjectId: collectionId, detail: { testCaseId } });
    return this.collection(collectionId);
  }

  private async require(id: string) {
    const row = await this.d.cases.get(id);
    if (!row) throw new PlatformError('not-found', 'Test case not found');
    return row;
  }

  private name(raw: string) {
    const name = raw.trim();
    if (name.length < 1 || name.length > 120) throw new PlatformError('validation', 'Name must be between 1 and 120 characters.');
    return name;
  }

  private summary(raw: string) {
    const summary = raw.trim();
    if (summary.length > 500) throw new PlatformError('validation', 'Summary must be 500 characters or fewer.');
    return summary;
  }

  private steps(raw: string) {
    const steps = raw.trim();
    if (steps.length < 1 || steps.length > 8000) throw new PlatformError('validation', 'Steps are required, up to 8000 characters.');
    return steps;
  }

  private expected(raw: string) {
    const expected = raw.trim();
    if (expected.length < 1 || expected.length > 4000) throw new PlatformError('validation', 'Expected result is required, up to 4000 characters.');
    return expected;
  }

  private key(name: string) {
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (key.length < 1) throw new PlatformError('validation', 'Name needs at least one letter or number.');
    return key;
  }

  private reference(raw: string) {
    const reference = raw.trim();
    if (reference.length > 50) throw new PlatformError('validation', 'Reference must be 50 characters or fewer.');
    return reference;
  }

  private kind(raw: TestCaseKind): TestCaseKind {
    if (raw === 'negative' || raw === 'edge' || raw === 'positive') return raw;
    throw new PlatformError('validation', 'Kind must be positive, negative, or edge.');
  }

  private priority(raw: TestCasePriority): TestCasePriority {
    if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
    throw new PlatformError('validation', 'Priority must be high, medium, or low.');
  }
}
