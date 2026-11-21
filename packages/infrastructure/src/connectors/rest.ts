import { PlatformError } from '@qa/domain';
import type { HttpPort, HttpRequest } from '@qa/connector-sdk';

export function required(value: string | undefined, what: string): string {
  if (!value) throw new PlatformError('validation', `${what} is required`);
  return value;
}

export function joinUrl(base: string, path: string, query?: Record<string, string | undefined>): string {
  const u = new URL(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  // Azure DevOps OData params ($expand, $top, …) must keep a literal `$`.
  // URLSearchParams encodes it as %24; some WIT gateways then ignore the expand.
  return u.toString().replace(/%24/gi, '$');
}

export interface JsonResult {
  status: number;
  headers: Record<string, string>;
  body: any;
  text: string;
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
    // Playwright MCP may answer with text/event-stream (`data: {…}`); callers parse `text`.
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (res.status === 401) throw new PlatformError('auth', `${system} rejected the credential`);
  if (res.status === 403) throw new PlatformError('denied', `${system} refused this credential`);
  if (res.status === 404) throw new PlatformError('not-found', `${system} could not find that item`);
  if (res.status >= 400) throw new PlatformError('transient', `${system} returned status ${res.status}`);
  return { status: res.status, headers, body, text };
}

const MAX_ATTACHMENT_BYTES = 5_000_000;

/** GET bytes. A 3xx is returned so the caller can follow a same-site redirect. */
export async function requestBytes(http: HttpPort, req: HttpRequest, system: string): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  let res;
  try {
    res = await http.request(req);
  } catch (e) {
    if (e instanceof PlatformError) throw e;
    throw new PlatformError('transient', `Could not reach ${system}`);
  }
  const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (res.status === 401) throw new PlatformError('auth', `${system} rejected the credential`);
  if (res.status === 403) throw new PlatformError('denied', `${system} refused this credential`);
  if (res.status === 404) throw new PlatformError('not-found', `${system} could not find that item`);
  if (res.status >= 400) throw new PlatformError('transient', `${system} returned status ${res.status}`);
  return { status: res.status, headers, body: res.body };
}

/** Download an attachment. The credential is sent only to the connector's own host. */
export async function downloadBytes(http: HttpPort, startUrl: string, authorization: string, system: string, home: URL): Promise<{ body: Uint8Array; mimeType?: string }> {
  let current = startUrl;
  let sendAuth = true;
  for (let hop = 0; hop < 3; hop++) {
    const headers: Record<string, string> = { accept: '*/*' };
    if (sendAuth) headers.authorization = authorization;
    const res = await requestBytes(http, { method: 'GET', url: current, headers }, system);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      if (!loc) throw new PlatformError('transient', `${system} did not return the attachment`);
      const next = new URL(loc, current);
      sendAuth = next.host === home.host;
      current = next.toString();
      continue;
    }
    if (res.body.byteLength > MAX_ATTACHMENT_BYTES) throw new PlatformError('validation', 'The attachment is larger than 5 MB.');
    return { body: res.body, mimeType: res.headers['content-type']?.split(';')[0] };
  }
  throw new PlatformError('transient', `${system} did not return the attachment`);
}
