import { ErrorResponse, SessionResponse, type ZodType } from '@qa/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorClass: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  fetchImpl?: typeof fetch;
  /** Called once when the server says the session is missing or expired. */
  onUnauthenticated?: () => void;
}

export interface ApiClient {
  get<T>(path: string, schema: ZodType<T>): Promise<T>;
  post<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T>;
}

/**
 * Cookie-session client. State-changing requests carry the CSRF token the API issues for the current
 * session; in development without OIDC the endpoint does not exist and requests go without one.
 */
export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let csrf: Promise<string | undefined> | undefined;

  const loadCsrf = async (): Promise<string | undefined> => {
    const res = await f('/api/v1/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    return SessionResponse.parse(await res.json()).csrfToken;
  };

  async function send<T>(method: string, path: string, body: unknown, schema: ZodType<T>): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      csrf ??= loadCsrf();
      const token = await csrf;
      if (token) headers['x-csrf-token'] = token;
    }
    const res = await f(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) {
      csrf = undefined;
      opts.onUnauthenticated?.();
    }
    const text = await res.text();
    const json: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const parsed = ErrorResponse.safeParse(json);
      throw new ApiError(res.status, parsed.success ? parsed.data.error.class : 'unknown', parsed.success ? parsed.data.error.message : `Request failed (${res.status})`);
    }
    return schema.parse(json);
  }

  return {
    get: (path, schema) => send('GET', path, undefined, schema),
    post: (path, body, schema) => send('POST', path, body, schema),
  };
}

const safeJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};
