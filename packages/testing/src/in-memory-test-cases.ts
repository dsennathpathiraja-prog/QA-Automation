import { PlatformError } from '@qa/domain';
import type { TestCaseRecord, TestCaseRepository, TestCaseVersionRecord } from '@qa/application';

export class InMemoryTestCaseRepository implements TestCaseRepository {
  readonly cases = new Map<string, TestCaseRecord>();
  readonly versionRows = new Map<string, TestCaseVersionRecord[]>();
  readonly collections = new Map<string, { id: string; name: string; description: string }>();
  readonly members = new Map<string, { testCaseId: string; position: number }[]>();

  async list() {
    return [...this.cases.values()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).map((r) => structuredClone(r));
  }

  async get(id: string) {
    const row = this.cases.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async findKey(key: string) {
    const row = [...this.cases.values()].find((r) => r.key === key);
    return row ? structuredClone(row) : undefined;
  }

  async insert(row: { id: string; key: string; name: string; summary: string; steps: string; expected: string }) {
    if ([...this.cases.values()].some((r) => r.key === row.key)) throw new PlatformError('conflict', 'A test case with that name already exists.');
    const now = new Date();
    const saved: TestCaseRecord = { id: row.id, key: row.key, name: row.name, summary: row.summary, currentVersion: 1, updatedAt: now };
    this.cases.set(saved.id, saved);
    this.versionRows.set(saved.id, [{ version: 1, steps: row.steps, expected: row.expected, createdAt: now }]);
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
    if (!row) throw new PlatformError('not-found', 'Test case not found');
    row.summary = summary;
    row.updatedAt = new Date();
    return structuredClone(row);
  }

  async listCollections() {
    return [...this.collections.values()].map((c) => ({ ...c, size: this.members.get(c.id)?.length ?? 0 }));
  }

  async getCollection(id: string) {
    const row = this.collections.get(id);
    if (!row) return undefined;
    const cases = (this.members.get(id) ?? []).flatMap((m) => {
      const item = this.cases.get(m.testCaseId);
      return item ? [{ id: item.id, name: item.name, version: item.currentVersion, position: m.position }] : [];
    });
    return { ...row, cases };
  }

  async insertCollection(row: { id: string; name: string; description: string }) {
    if ([...this.collections.values()].some((c) => c.name.toLowerCase() === row.name.toLowerCase())) throw new PlatformError('conflict', 'A collection with that name already exists.');
    this.collections.set(row.id, row);
    this.members.set(row.id, []);
    return { ...row, size: 0 };
  }

  async addCase(collectionId: string, testCaseId: string) {
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
}
