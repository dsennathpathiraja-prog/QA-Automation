import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { ActorRef } from './connector-service';
import type { AuditSink } from './ports';

export interface TestCaseRecord {
  id: string;
  key: string;
  name: string;
  summary: string;
  workItem: string;
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
}

export interface TestCaseRepository {
  list(): Promise<TestCaseRecord[]>;
  get(id: string): Promise<TestCaseRecord | undefined>;
  findKey(key: string): Promise<TestCaseRecord | undefined>;
  insert(row: { id: string; key: string; name: string; summary: string; workItem: string; steps: string; expected: string }): Promise<TestCaseRecord>;
  current(id: string): Promise<TestCaseVersionRecord | undefined>;
  versions(id: string): Promise<TestCaseVersionRecord[]>;
  saveVersion(id: string, version: number, steps: string, expected: string, summary: string): Promise<TestCaseRecord>;
  saveSummary(id: string, summary: string): Promise<TestCaseRecord>;
  listCollections(): Promise<TestCollectionRecord[]>;
  getCollection(id: string): Promise<{ id: string; name: string; description: string; cases: CollectionCaseRecord[] } | undefined>;
  insertCollection(row: { id: string; name: string; description: string }): Promise<TestCollectionRecord>;
  addCase(collectionId: string, testCaseId: string): Promise<'added' | 'exists'>;
  removeCase(collectionId: string, testCaseId: string): Promise<boolean>;
}

export interface TestCaseView {
  id: string;
  key: string;
  name: string;
  summary: string;
  workItem: string;
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
  version: number;
  updatedAt: string;
}

const itemOf = (r: TestCaseRecord): TestCaseListItem => ({
  id: r.id, key: r.key, name: r.name, summary: r.summary, workItem: r.workItem, version: r.currentVersion, updatedAt: r.updatedAt.toISOString(),
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

  async create(actor: ActorRef, input: { name: string; summary?: string; steps: string; expected: string; workItem?: string }): Promise<TestCaseView> {
    const name = this.name(input.name);
    const workItem = this.summary(input.workItem ?? '');
    const key = this.key(workItem ? `${workItem} ${name}` : name);
    if (await this.d.cases.findKey(key)) throw new PlatformError('conflict', 'A test case with that name already exists.');
    const summary = this.summary(input.summary ?? '');
    const steps = this.steps(input.steps);
    const expected = this.expected(input.expected);
    const row = await this.d.cases.insert({ id: randomUUID(), key, name, summary, workItem, steps, expected });
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

  async addToCollection(actor: ActorRef, collectionId: string, testCaseId: string) {
    await this.collection(collectionId);
    await this.require(testCaseId);
    const added = await this.d.cases.addCase(collectionId, testCaseId);
    if (added === 'exists') throw new PlatformError('conflict', 'That case is already in this collection.');
    await this.d.audit.append({ actorId: actor.id, action: 'testcase.collection.add', subjectType: 'test_collection', subjectId: collectionId, detail: { testCaseId } });
    return this.collection(collectionId);
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
}
