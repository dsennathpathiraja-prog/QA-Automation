import { PlatformError } from '@qa/domain';

export interface TokenClaims {
  permissions?: string;
  expiresAt?: Date;
}

const PASSWORD_KEYS = ['password', 'passwd'] as const;
const USERNAME_KEYS = ['username', 'user', 'login'] as const;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

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
 * Squash secret bag: personal API token only.
 * Username/password are ignored when a token is present, and refused when the token is missing
 * (Squash 15.x returns "Basic authentication is not allowed for REST API" for Basic).
 */
export function parseSquashSecrets(raw: unknown): { token: string } {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const token = typeof obj.token === 'string' ? obj.token.trim() : '';
  const hasPassword = PASSWORD_KEYS.some((k) => nonEmpty(obj[k]));
  const hasUsername = USERNAME_KEYS.some((k) => nonEmpty(obj[k]));
  if (!token && (hasPassword || hasUsername)) {
    throw new PlatformError(
      'validation',
      'SquashTM does not accept username/password for the REST API. Paste a personal API token into the API token field (Authorization: Bearer only).',
    );
  }
  if (!token) throw new PlatformError('validation', 'API token is required');
  if (token.length < 20) throw new PlatformError('validation', 'API token is required');
  // Ignore username/password — never build Authorization: Basic from them.
  return { token };
}

/** Drop userinfo from a Squash base URL so HTTP clients cannot turn it into Basic auth. */
export function scrubSquashBaseUrl(raw: string): string {
  const u = new URL(raw);
  u.username = '';
  u.password = '';
  return u.href;
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
