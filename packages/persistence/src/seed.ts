import { sql } from 'drizzle-orm';
import { ROLES, ROLE_PERMISSIONS } from '@qa/domain';
import { DEFAULT_GROUP_MAPPINGS } from '@qa/security';
import type { Db } from './db';
import { idpGroupMapping, role, rolePermission } from './schema';

const ROLE_NAMES: Record<string, string> = {
  administrator: 'Administrator',
  qa_lead: 'QA Lead',
  qa_engineer: 'QA Engineer',
  business_user: 'Business User',
};

/**
 * Roles and their permissions are defined in code (packages/domain) and mirrored here for reporting and joins.
 * The code remains the source of truth: this resyncs on every start and never trusts rows an operator edited.
 */
export async function seedRoles(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const key of ROLES) {
      await tx.insert(role).values({ key, name: ROLE_NAMES[key] ?? key, systemDefined: true }).onConflictDoNothing({ target: role.key });
    }
    const rows = await tx.select({ id: role.id, key: role.key }).from(role);
    const idByKey = new Map(rows.map((r) => [r.key, r.id]));
    for (const key of ROLES) {
      const roleId = idByKey.get(key)!;
      await tx.delete(rolePermission).where(sql`${rolePermission.roleId} = ${roleId}`);
      const perms = [...ROLE_PERMISSIONS[key]];
      if (perms.length > 0) await tx.insert(rolePermission).values(perms.map((permission) => ({ roleId, permission })));
    }
  });
}

/** The four default IdP groups; only inserted when no mapping exists so administrator edits are never overwritten. */
export async function seedDefaultGroupMappings(db: Db): Promise<number> {
  return db.transaction(async (tx) => {
    const existing = await tx.select({ id: idpGroupMapping.id }).from(idpGroupMapping).limit(1);
    if (existing.length > 0) return 0;
    const rows = await tx.select({ id: role.id, key: role.key }).from(role);
    const idByKey = new Map(rows.map((r) => [r.key, r.id]));
    const values = DEFAULT_GROUP_MAPPINGS.map((m) => ({ idpGroup: m.idpGroup, roleId: idByKey.get(m.role)! }));
    await tx.insert(idpGroupMapping).values(values);
    return values.length;
  });
}
