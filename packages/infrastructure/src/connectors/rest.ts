import { PlatformError } from '@qa/domain';
import type { HttpPort, HttpRequest } from '@qa/connector-sdk';

export function required(value: string | undefined, what: string): string {
  if (!value) throw new PlatformError('validation', `${what} is required`);
  return value;
}

export function joinUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

export interface JsonResult {
  status: number;
  headers: Record<string, string>;
  body: any;
}

/** GET or POST JSON. Error messages name the system and the status, never the credential or the body. */
export async function requestJson(http: HttpPort, req: HttpRequest, system: string): Promise<JsonResult> {
  let res;
  try {
    res = await http.request(req);
  } catch (e) {
    if (e instanceof PlatformError) throw e;
    throw new PlatformError('transient', `Could not reach ${system}`);
  }
  const text = res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (res.status === 401) throw new PlatformError('auth', `${system} rejected the credential`);
  if (res.status === 403) throw new PlatformError('denied', `${system} refused this credential`);
  if (res.status === 404) throw new PlatformError('not-found', `${system} could not find that item`);
  if (res.status >= 400) throw new PlatformError('transient', `${system} returned status ${res.status}`);
  return { status: res.status, headers, body };
}
