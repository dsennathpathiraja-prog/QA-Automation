import type { SessionRecord, SessionStore } from '@qa/domain';

/** Single-instance store for development, tests and the initial Compose deployment. Postgres store follows with persistence. */
export class InMemorySessionStore implements SessionStore {
  private readonly m = new Map<string, SessionRecord>();

  async create(rec: SessionRecord): Promise<void> {
    this.m.set(rec.id, { ...rec });
  }
  async get(id: string): Promise<SessionRecord | undefined> {
    const r = this.m.get(id);
    return r ? { ...r } : undefined;
  }
  async touch(id: string, now: number): Promise<void> {
    const r = this.m.get(id);
    if (r) r.lastSeenAt = now;
  }
  async delete(id: string): Promise<void> {
    this.m.delete(id);
  }
  async deleteByIdpSession(idpSessionId: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.m) if (v.idpSessionId === idpSessionId) (this.m.delete(k), (n += 1));
    return n;
  }
  async deleteByUser(userId: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.m) if (v.userId === userId) (this.m.delete(k), (n += 1));
    return n;
  }
}
