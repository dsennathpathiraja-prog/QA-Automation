import { isRole, type Role } from '@qa/domain';

export type GroupFormat = 'name' | 'path' | 'object-id';

export interface GroupMapping {
  idpGroup: string;
  role: Role;
  enabled?: boolean;
}

export const DEFAULT_GROUP_MAPPINGS: readonly GroupMapping[] = [
  { idpGroup: 'QA-Platform-Admins', role: 'administrator' },
  { idpGroup: 'QA-Platform-Leads', role: 'qa_lead' },
  { idpGroup: 'QA-Platform-Engineers', role: 'qa_engineer' },
  { idpGroup: 'QA-Platform-Users', role: 'business_user' },
];

export interface MapperOptions {
  mappings: readonly GroupMapping[];
  groupFormat?: GroupFormat;
  caseSensitive?: boolean;
}

export interface MappingResult {
  roles: Role[];
  authorized: boolean;
  unmappedGroups: string[];
}

/**
 * IdP-agnostic: turns a list of group claims into internal roles. Authorization elsewhere uses
 * only the resulting roles, never IdP claims. Roles are the union of all mapped groups.
 */
export function mapGroupsToRoles(claims: readonly string[] | undefined, opts: MapperOptions): MappingResult {
  const format = opts.groupFormat ?? 'name';
  const norm = (g: string) => {
    let v = g.trim();
    if (format === 'path') v = v.split('/').filter(Boolean).pop() ?? v;
    return opts.caseSensitive ? v : v.toLowerCase();
  };
  const table = new Map<string, Role>();
  for (const m of opts.mappings) {
    if (m.enabled === false) continue;
    if (!isRole(m.role)) continue;
    table.set(norm(m.idpGroup), m.role);
  }
  const roles = new Set<Role>();
  const unmapped: string[] = [];
  for (const g of claims ?? []) {
    const role = table.get(norm(g));
    if (role) roles.add(role);
    else unmapped.push(g);
  }
  return { roles: [...roles], authorized: roles.size > 0, unmappedGroups: unmapped };
}
