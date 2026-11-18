import { PlatformError } from '@qa/domain';
import type { EnvironmentAuthorizationRecord, EnvironmentPatch, EnvironmentRecord, EnvironmentRepository, NewEnvironment } from '@qa/application';

export class InMemoryEnvironmentRepository implements EnvironmentRepository {
  readonly rows = new Map<string, EnvironmentRecord>();
  readonly authorizations: EnvironmentAuthorizationRecord[] = [];

  async list() {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async insert(n: NewEnvironment) {
    if ([...this.rows.values()].some((r) => r.name.toLowerCase() === n.name.toLowerCase())) throw new PlatformError('conflict', `An environment named "${n.name}" already exists.`);
    const now = new Date();
    const rec: EnvironmentRecord = { ...n, createdAt: now, updatedAt: now };
    this.rows.set(rec.id, structuredClone(rec));
    return structuredClone(rec);
  }

  async update(id: string, patch: EnvironmentPatch) {
    const row = this.rows.get(id);
    if (!row) throw new PlatformError('not-found', 'Environment not found');
    if (patch.name && [...this.rows.values()].some((r) => r.id !== id && r.name.toLowerCase() === patch.name!.toLowerCase())) {
      throw new PlatformError('conflict', `An environment named "${patch.name}" already exists.`);
    }
    const next = { ...row, updatedAt: new Date() };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) Object.assign(next, { [key]: value });
    }
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async softDelete(id: string) {
    this.rows.delete(id);
  }

  async activeAuthorization(environmentId: string, at: Date) {
    return this.authorizations.find((a) => a.environmentId === environmentId && a.status === 'active' && a.validFrom <= at && a.validUntil > at);
  }
}
