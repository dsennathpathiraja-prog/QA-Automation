import { PlatformError } from '@qa/domain';
import type { HttpResponse } from '@qa/connector-sdk';

/** Maps a failed provider response onto the platform error taxonomy so the gateway can decide on fallback and retry. */
export function providerError(res: HttpResponse, what: string): PlatformError {
  let detail = '';
  try {
    const j = res.json<{ error?: string | { message?: string } }>();
    detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? '');
  } catch {
    detail = '';
  }
  const msg = `${what} failed with status ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
  if (res.status === 404 && /model/i.test(detail)) return new PlatformError('not-found', msg, { unavailable: true });
  if (res.status === 401 || res.status === 403) return new PlatformError('auth', msg);
  if (res.status === 408 || res.status === 429) return new PlatformError('rate-limited', msg);
  if (res.status >= 500) return new PlatformError('transient', msg);
  return new PlatformError('validation', msg);
}
