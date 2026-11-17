import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { PlatformError } from '@qa/domain';
import type { HttpPort, HttpRequest, HttpResponse } from '@qa/connector-sdk';
import type { EgressPolicy, EgressRule } from './egress-policy';

export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  headers: { forEach(cb: (v: string, k: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface HardenedHttpOptions {
  egress: EgressPolicy;
  /** Methods allowed without further checks. Read-only providers pass ['GET', 'HEAD']. */
  allowedMethods?: readonly string[];
  /** Extra gate for methods outside allowedMethods (e.g. read-only POST search endpoints, GraphQL queries). */
  allowOther?: (req: HttpRequest) => boolean;
  resolve?: (host: string) => Promise<string[]>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
}

const defaultResolve = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true })).map((a) => a.address);

export class HardenedHttpClient implements HttpPort {
  private readonly allowed: Set<string>;

  constructor(private readonly o: HardenedHttpOptions) {
    this.allowed = new Set((o.allowedMethods ?? ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).map((m) => m.toUpperCase()));
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    if (!this.allowed.has(method) && !this.o.allowOther?.({ ...req, method })) {
      throw new PlatformError('denied', `HTTP method ${method} is not allowed for this connector`);
    }
    let url = new URL(req.url);
    const maxRedirects = this.o.maxRedirects ?? 3;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const rule = this.o.egress.assertAllowed(url);
      const ips = await this.resolveAndCheck(url, rule);
      const res = await this.send(url, { ...req, method }, ips[0]!);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers['location'];
        if (!loc) return res;
        if (method !== 'GET' && method !== 'HEAD') throw new PlatformError('denied', 'redirects are only followed for GET/HEAD');
        url = new URL(loc, url);
        continue;
      }
      return res;
    }
    throw new PlatformError('denied', 'too many redirects');
  }

  private async resolveAndCheck(url: URL, rule: EgressRule): Promise<string[]> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const ips = (await (this.o.resolve ?? defaultResolve)(host));
    if (ips.length === 0) throw new PlatformError('transient', `could not resolve ${host}`);
    this.o.egress.assertIps(ips, rule);
    return ips;
  }

  private async send(url: URL, req: HttpRequest, pinnedIp: string): Promise<HttpResponse> {
    const timeoutMs = this.o.timeoutMs ?? 30_000;
    const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    // DNS pinning: connect to the address we validated, not whatever a second lookup returns.
    const dispatcher = new Agent({
      connect: {
        lookup: (_h, opts, cb) => {
          const fam = pinnedIp.includes(':') ? 6 : 4;
          if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: unknown) => void)(null, [{ address: pinnedIp, family: fam }]);
          else cb(null, pinnedIp, fam);
        },
      },
    });
    try {
      const f = (this.o.fetchImpl ?? (undiciFetch as unknown as FetchLike));
      const res = await f(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal,
        redirect: 'manual',
        dispatcher,
      });
      const buf = new Uint8Array(await res.arrayBuffer());
      const max = this.o.maxBodyBytes ?? 25 * 1024 * 1024;
      if (buf.byteLength > max) throw new PlatformError('validation', 'response body exceeds size limit');
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return {
        status: res.status,
        headers,
        body: buf,
        text: () => new TextDecoder().decode(buf),
        json: <T>() => JSON.parse(new TextDecoder().decode(buf)) as T,
      };
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      const name = (e as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new PlatformError('transient', 'request timed out or was aborted', undefined, e);
      throw new PlatformError('transient', `network error: ${(e as Error).message}`, undefined, e);
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }
}
