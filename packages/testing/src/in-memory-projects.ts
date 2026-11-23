import { PlatformError } from '@qa/domain';
import type { NewProject, ProjectPatch, ProjectRecord, ProjectRepository, ProjectStatus } from '@qa/application';

export class InMemoryProjectRepository implements ProjectRepository {
  readonly rows = new Map<string, ProjectRecord>();
  private readonly deleted = new Set<string>();

  async list(filter?: { status?: ProjectStatus }) {
    return [...this.rows.values()]
      .filter((r) => !this.deleted.has(r.id) && (!filter?.status || r.status === filter.status))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    return this.deleted.has(id) ? undefined : this.rows.get(id);
  }

  async getByKey(key: string) {
    return [...this.rows.values()].find((r) => !this.deleted.has(r.id) && r.key === key);
  }

  async insert(n: NewProject) {
    if ([...this.rows.values()].some((r) => !this.deleted.has(r.id) && (r.key === n.key || r.name.toLowerCase() === n.name.toLowerCase()))) {
      throw new PlatformError('conflict', 'A project with that key or name already exists.');
    }
    const now = new Date();
    const rec: ProjectRecord = { id: n.id, key: n.key, name: n.name, description: n.description, status: 'active', createdAt: now, updatedAt: now };
    this.rows.set(n.id, rec);
    return structuredClone(rec);
  }

  async update(id: string, patch: ProjectPatch) {
    const rec = this.rows.get(id);
    if (!rec || this.deleted.has(id)) throw new PlatformError('not-found', 'Project not found');
    if (patch.name && patch.name !== rec.name && [...this.rows.values()].some((r) => r.id !== id && !this.deleted.has(r.id) && r.name.toLowerCase() === patch.name!.toLowerCase())) {
      throw new PlatformError('conflict', 'A project with that name already exists.');
    }
    Object.assign(rec, patch, { updatedAt: new Date() });
    return structuredClone(rec);
  }

  async softDelete(id: string) {
    this.deleted.add(id);
  }
}
