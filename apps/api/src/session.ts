import type { FastifyRequest } from 'fastify';
import type { PlatformEnv } from '@qa/domain';
import { DEFAULT_GROUP_MAPPINGS, mapGroupsToRoles, type GroupMapping, type Principal } from '@qa/security';

/**
 * Resolves the caller from a request. The production implementation validates the Keycloak/OIDC
 * session cookie (Phase 1, next increment); everything downstream only sees a Principal with
 * internal roles, never IdP claims.
 */
export interface SessionResolver {
  resolve(req: FastifyRequest): Promise<Principal | undefined>;
}

/** Local development and tests only: trusts `x-dev-user` / `x-dev-groups` headers. */
export class DevHeaderSessionResolver implements SessionResolver {
  constructor(
    platformEnv: PlatformEnv,
    private readonly mappings: readonly GroupMapping[] = DEFAULT_GROUP_MAPPINGS,
  ) {
    if (platformEnv === 'production') throw new Error('DevHeaderSessionResolver must not be used when PLATFORM_ENV=production');
  }

  async resolve(req: FastifyRequest): Promise<Principal | undefined> {
    const user = req.headers['x-dev-user'];
    if (typeof user !== 'string' || user.length === 0) return undefined;
    const groups = String(req.headers['x-dev-groups'] ?? '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
    const { roles } = mapGroupsToRoles(groups, { mappings: this.mappings });
    return { id: user, displayName: user, roles };
  }
}
