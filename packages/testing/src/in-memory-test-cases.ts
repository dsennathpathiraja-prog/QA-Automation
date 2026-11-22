import { PlatformError } from '@qa/domain';
import type {
  CaseRunStatus,
  CaseStepProgress,
  TestCaseInsert,
  TestCaseKind,
  TestCasePriority,
  TestCaseRecord,
  TestCaseRepository,
  TestCaseVersionRecord,
  WorkItemCaseResultRecord,
  WorkItemRunRecord,
  WorkItemRunStatus,
} from '@qa/application';

export class InMemoryTestCaseRepository implements TestCaseRepository {
  readonly cases = new Map<string, TestCaseRecord>();
  readonly versionRows = new Map<string, TestCaseVersionRecord[]>();
  readonly collections = new Map<string, { id: string; name: string; description: string }>();
  readonly members = new Map<string, { testCaseId: string; position: number }[]>();
  readonly deletedCaseIds = new Set<string>();
  readonly deletedCollectionIds = new Set<string>();
  readonly workItemRuns: WorkItemRunRecord[] = [];
  readonly caseResults = new Map<string, WorkItemCaseResultRecord[]>();

  async list() {
    return [...this.cases.values()]
      .filter((r) => !this.deletedCaseIds.has(r.id))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((r) => structuredClone(r));
  }

  async get(id: string) {
    if (this.deletedCaseIds.has(id)) return undefined;
    const row = this.cases.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async findKey(key: string) {
    const row = [...this.cases.values()].find((r) => r.key === key && !this.deletedCaseIds.has(r.id));
    return row ? structuredClone(row) : undefined;
  }

  async insert(row: TestCaseInsert) {
    if ([...this.cases.values()].some((r) => r.key === row.key && !this.deletedCaseIds.has(r.id))) {
      throw new PlatformError('conflict', 'A test case with that name already exists.');
    }
    const now = new Date();
    const saved: TestCaseRecord = {
      id: row.id,
      key: row.key,
      name: row.name,
      summary: row.summary,
      workItem: row.workItem,
      kind: row.kind,
      priority: row.priority,
      currentVersion: 1,
      updatedAt: now,
    };
    this.cases.set(saved.id, saved);
    this.versionRows.set(saved.id, [{ version: 1, steps: row.steps, expected: row.expected, createdAt: now }]);
    this.deletedCaseIds.delete(saved.id);
    return structuredClone(saved);
  }

  async current(id: string) {
    const row = this.cases.get(id);
    const version = this.versionRows.get(id)?.find((v) => v.version === row?.currentVersion);
    return version ? structuredClone(version) : undefined;
  }

  async versions(id: string) {
    return structuredClone([...(this.versionRows.get(id) ?? [])].sort((a, b) => b.version - a.version));
  }

  async saveVersion(id: string, version: number, steps: string, expected: string, summary: string) {
    const row = this.cases.get(id);
    if (!row) throw new PlatformError('not-found', 'Test case not found');
    const now = new Date();
    this.versionRows.get(id)!.push({ version, steps, expected, createdAt: now });
    row.currentVersion = version;
    row.summary = summary;
    row.updatedAt = now;
    return structuredClone(row);
  }

  async saveSummary(id: string, summary: string) {
    const row = this.cases.get(id);
    if (!row || this.deletedCaseIds.has(id)) throw new PlatformError('not-found', 'Test case not found');
    row.summary = summary;
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async saveIdentity(id: string, patch: { name?: string; key?: string; kind?: TestCaseKind; priority?: TestCasePriority }) {
    const row = this.cases.get(id);
    if (!row || this.deletedCaseIds.has(id)) throw new PlatformError('not-found', 'Test case not found');
    if (patch.key !== undefined && [...this.cases.values()].some((r) => r.key === patch.key && r.id !== id && !this.deletedCaseIds.has(r.id))) {
      throw new PlatformError('conflict', 'A test case with that name already exists.');
    }
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.key !== undefined) row.key = patch.key;
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.priority !== undefined) row.priority = patch.priority;
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async softDelete(id: string) {
    if (!this.cases.has(id) || this.deletedCaseIds.has(id)) return false;
    this.deletedCaseIds.add(id);
    for (const [collectionId, members] of this.members) {
      this.members.set(collectionId, members.filter((m) => m.testCaseId !== id));
    }
    return true;
  }

  async softDeleteAllPlatform() {
    let cases = 0;
    let collections = 0;
    for (const id of this.cases.keys()) {
      if (this.deletedCaseIds.has(id)) continue;
      this.deletedCaseIds.add(id);
      cases += 1;
    }
    for (const id of this.collections.keys()) {
      if (this.deletedCollectionIds.has(id)) continue;
      this.deletedCollectionIds.add(id);
      collections += 1;
    }
    for (const collectionId of this.members.keys()) this.members.set(collectionId, []);
    return { cases, collections };
  }

  async listCollections() {
    return [...this.collections.values()]
      .filter((c) => !this.deletedCollectionIds.has(c.id))
      .map((c) => ({ ...c, size: this.members.get(c.id)?.length ?? 0 }));
  }

  async getCollection(id: string) {
    if (this.deletedCollectionIds.has(id)) return undefined;
    const row = this.collections.get(id);
    if (!row) return undefined;
    const cases = (this.members.get(id) ?? []).flatMap((m) => {
      if (this.deletedCaseIds.has(m.testCaseId)) return [];
      const item = this.cases.get(m.testCaseId);
      return item
        ? [{ id: item.id, name: item.name, version: item.currentVersion, position: m.position, kind: item.kind, priority: item.priority }]
        : [];
    });
    return { ...row, cases };
  }

  async insertCollection(row: { id: string; name: string; description: string }) {
    if ([...this.collections.values()].some((c) => !this.deletedCollectionIds.has(c.id) && c.name.toLowerCase() === row.name.toLowerCase())) {
      throw new PlatformError('conflict', 'A collection with that name already exists.');
    }
    this.collections.set(row.id, row);
    this.members.set(row.id, []);
    this.deletedCollectionIds.delete(row.id);
    return { ...row, size: 0 };
  }

  async addCase(collectionId: string, testCaseId: string) {
    if (this.deletedCollectionIds.has(collectionId)) throw new PlatformError('not-found', 'Collection not found');
    const members = this.members.get(collectionId);
    if (!members) throw new PlatformError('not-found', 'Collection not found');
    if (members.some((m) => m.testCaseId === testCaseId)) return 'exists';
    members.push({ testCaseId, position: members.length + 1 });
    return 'added';
  }

  async removeCase(collectionId: string, testCaseId: string) {
    const members = this.members.get(collectionId) ?? [];
    const next = members.filter((m) => m.testCaseId !== testCaseId);
    this.members.set(collectionId, next);
    return next.length !== members.length;
  }

  async softDeleteCollection(id: string) {
    if (!this.collections.has(id) || this.deletedCollectionIds.has(id)) return false;
    const members = [...(this.members.get(id) ?? [])];
    this.members.set(id, []);
    this.deletedCollectionIds.add(id);
    for (const member of members) {
      this.deletedCaseIds.add(member.testCaseId);
      for (const [collectionId, list] of this.members) {
        this.members.set(collectionId, list.filter((m) => m.testCaseId !== member.testCaseId));
      }
    }
    return true;
  }

  async listWorkItemRuns() {
    return this.workItemRuns.map((r) => structuredClone(r));
  }

  async getWorkItemRun(id: string) {
    const row = this.workItemRuns.find((r) => r.id === id);
    return row ? structuredClone(row) : undefined;
  }

  async insertWorkItemRun(row: { id: string; workItem: string; environmentId: string; environmentName: string; caseCount: number }) {
    const saved: WorkItemRunRecord = { ...row, status: 'prepared', createdAt: new Date() };
    this.workItemRuns.unshift(saved);
    return structuredClone(saved);
  }

  async updateWorkItemRun(id: string, patch: { status: WorkItemRunStatus; squashSync?: string; finishedAt?: Date }) {
    const row = this.workItemRuns.find((r) => r.id === id);
    if (!row) throw new PlatformError('not-found', 'Work item execution not found');
    row.status = patch.status;
    if (patch.squashSync !== undefined) row.squashSync = patch.squashSync;
    if (patch.finishedAt !== undefined) row.finishedAt = patch.finishedAt;
    return structuredClone(row);
  }

  async claimQueuedWorkItemRun() {
    const row = this.workItemRuns.find((r) => r.status === 'queued');
    if (!row) return undefined;
    row.status = 'running';
    return structuredClone(row);
  }

  async replaceCaseResults(executionId: string, results: Array<{ id: string; testCaseId: string; name: string; status: CaseRunStatus; message: string; screenshotPng?: string; squashExecutionId?: string; steps?: CaseStepProgress[] }>) {
    this.caseResults.set(executionId, results.map((r) => structuredClone(r)));
  }

  async listCaseResults(executionId: string) {
    return structuredClone(this.caseResults.get(executionId) ?? []);
  }

  async getCaseResult(executionId: string, testCaseId: string) {
    const row = (this.caseResults.get(executionId) ?? []).find((r) => r.testCaseId === testCaseId);
    return row ? structuredClone(row) : undefined;
  }
}
