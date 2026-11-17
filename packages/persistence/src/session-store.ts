import { createHash } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import type { SessionRecord, SessionStore } from '@qa/domain';
import type { Db } from './db';
import { appSession } from './schema';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

type Row = typeof appSession.$inferSelect;
const toRecord = (token: string, r: Row): SessionRecord => ({
  id: token,
  userId: r.userId,
  displayName: r.displayName,
  email: r.email ?? undefined,
  groups: r.groups,
  roles: r.roles,
  csrfToken: r.csrfToken,
  idToken: r.idToken,
  idpSessionId: r.idpSessionId ?? undefined,
  createdAt: r.createdAt.getTime(),
  lastSeenAt: r.lastSeenAt.getTime(),
  expiresAt: r.expiresAt.getTime(),
});

/** Stores only the SHA-256 of the session token, so a leaked database dump cannot be replayed as a cookie. */
export class PgSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async create(rec: SessionRecord): Promise<void> {
    await this.db.insert(appSession).values({
      tokenHash: hash(rec.id),
      userId: rec.userId,
      displayName: rec.displayName,
      email: rec.email ?? null,
      groups: rec.groups,
      roles: rec.roles,
      csrfToken: rec.csrfToken,
      idToken: rec.idToken,
      idpSessionId: rec.idpSessionId ?? null,
      createdAt: new Date(rec.createdAt),
      lastSeenAt: new Date(rec.lastSeenAt),
      expiresAt: new Date(rec.expiresAt),
    });
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    const rows = await this.db.select().from(appSession).where(eq(appSession.tokenHash, hash(id))).limit(1);
    return rows[0] ? toRecord(id, rows[0]) : undefined;
  }

  async touch(id: string, now: number): Promise<void> {
    await this.db.update(appSession).set({ lastSeenAt: new Date(now) }).where(eq(appSession.tokenHash, hash(id)));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(appSession).where(eq(appSession.tokenHash, hash(id)));
  }

  async deleteByIdpSession(idpSessionId: string): Promise<number> {
    const r = await this.db.delete(appSession).where(eq(appSession.idpSessionId, idpSessionId)).returning({ h: appSession.tokenHash });
    return r.length;
  }

  async deleteByUser(userId: string): Promise<number> {
    const r = await this.db.delete(appSession).where(eq(appSession.userId, userId)).returning({ h: appSession.tokenHash });
    return r.length;
  }

  /** Housekeeping: drop sessions past their absolute expiry. */
  async purgeExpired(now: number): Promise<number> {
    const r = await this.db.delete(appSession).where(lt(appSession.expiresAt, new Date(now))).returning({ h: appSession.tokenHash });
    return r.length;
  }
}

