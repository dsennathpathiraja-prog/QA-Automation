export interface TokenClaims {
  permissions?: string;
  expiresAt?: Date;
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
