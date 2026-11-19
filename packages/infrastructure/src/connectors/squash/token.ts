import { PlatformError } from '@qa/domain';

export interface TokenClaims {
  permissions?: string;
  expiresAt?: Date;
}

/**
 * Squash 15.x REST accepts only `Authorization: Bearer <token>`.
 * Trim paste noise on save and on lease; reject empty after trim.
 */
export function normalizeSquashToken(raw: unknown): string {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) throw new PlatformError('validation', 'API token is required');
  return token;
}

/**
 * Squash personal API tokens are JWTs. We read the payload only to show permission and expiry to
 * administrators; the claims are not trusted for any decision (Squash enforces them).
 */
export function readTokenClaims(token: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { permissions?: unknown; exp?: unknown };
    return {
      permissions: typeof payload.permissions === 'string' ? payload.permissions : undefined,
      expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : undefined,
    };
  } catch {
    return {};
  }
}
