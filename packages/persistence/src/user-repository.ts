import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@qa/domain';
import type { Db } from './db';
import { appUser, role, userRole } from './schema';

export interface LoginProfile {
  subject: string;
  displayName: string;
  email?: string;
  roles: readonly string[];
}

/**
 * Just-in-time provisioning. Roles with source `idp` mirror the IdP groups at each login; roles granted
 * manually are never touched here. Authorization still reads the session's roles, not these rows.
 */
export class PgUserRepository {
  constructor(private readonly db: Db) {}

  async findBySubject(subject: string): Promise<{ id: string; displayName: string } | undefined> {
    const [row] = await this.db.select({ id: appUser.id, displayName: appUser.displayName }).from(appUser).where(eq(appUser.externalSubject, subject)).limit(1);
    return row;
  }

  async recordLogin(p: LoginProfile, now: Date = new Date()): Promise<{ userId: string; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: appUser.id, status: appUser.status }).from(appUser).where(eq(appUser.externalSubject, p.subject)).limit(1);
      let userId: string;
      let created = false;
      if (existing[0]) {
        userId = existing[0].id;
        await tx
          .update(appUser)
          .set({ displayName: p.displayName, email: p.email ?? null, lastLoginAt: now, updatedAt: now, rowVersion: sql`${appUser.rowVersion} + 1` })
          .where(eq(appUser.id, userId));
      } else {
        userId = uuidv7();
        created = true;
        await tx.insert(appUser).values({ id: userId, externalSubject: p.subject, displayName: p.displayName, email: p.email ?? null, lastLoginAt: now });
      }
      const wanted = p.roles.length === 0 ? [] : await tx.select({ id: role.id, key: role.key }).from(role).where(inArray(role.key, [...p.roles]));
      const wantedIds = new Set(wanted.map((r) => r.id));
      const current = await tx.select({ roleId: userRole.roleId }).from(userRole).where(and(eq(userRole.userId, userId), eq(userRole.source, 'idp')));
      for (const c of current) {
        if (!wantedIds.has(c.roleId)) await tx.delete(userRole).where(and(eq(userRole.userId, userId), eq(userRole.roleId, c.roleId), eq(userRole.source, 'idp')));
      }
      const have = new Set(current.map((c) => c.roleId));
      for (const id of wantedIds) if (!have.has(id)) await tx.insert(userRole).values({ userId, roleId: id, source: 'idp' }).onConflictDoNothing();
      return { userId, created };
    });
  }

  async isDisabled(subject: string): Promise<boolean> {
    const r = await this.db.select({ status: appUser.status }).from(appUser).where(eq(appUser.externalSubject, subject)).limit(1);
    return r[0]?.status === 'disabled';
  }
}
