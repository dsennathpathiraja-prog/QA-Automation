import { PlatformError, assertValidRunnerSpec, type RunnerHandle, type RunnerLauncher, type RunnerSpec, type RunnerStatus } from '@qa/domain';
import type { HttpPort } from '@qa/connector-sdk';

/**
 * RunnerLauncher that asks the separate `runner-launcher` service. The worker holds only a short-lived
 * bearer token for that service, never a container socket.
 */
export class RemoteRunnerLauncher implements RunnerLauncher {
  constructor(private readonly o: { baseUrl: string; token: () => string | Promise<string>; http: HttpPort }) {}

  async launch(spec: RunnerSpec, opts?: { signal?: AbortSignal }): Promise<RunnerHandle> {
    assertValidRunnerSpec(spec);
    const h = await this.send<{ id: string; runId: string; startedAt: string }>('POST', '/v1/runners', spec, opts?.signal);
    return { id: h.id, runId: h.runId, startedAt: new Date(h.startedAt) };
  }

  async status(runnerId: string): Promise<RunnerStatus> {
    return this.status1(await this.send('GET', `/v1/runners/${encodeURIComponent(runnerId)}`));
  }

  async stop(runnerId: string, reason: string): Promise<void> {
    await this.send('POST', `/v1/runners/${encodeURIComponent(runnerId)}/stop`, { reason });
  }

  async list(labels: Record<string, string>): Promise<RunnerStatus[]> {
    const qs = new URLSearchParams(Object.entries(labels).map(([k, v]): [string, string] => [`label.${k}`, v])).toString();
    const r = await this.send<{ items: unknown[] }>('GET', `/v1/runners${qs ? `?${qs}` : ''}`);
    return r.items.map((i) => this.status1(i));
  }

  private status1(raw: unknown): RunnerStatus {
    const s = raw as RunnerStatus & { finishedAt?: string };
    return { ...s, finishedAt: s.finishedAt ? new Date(s.finishedAt) : undefined };
  }

  private async send<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await this.o.http.request({
      method,
      url: `${this.o.baseUrl.replace(/\/+$/, '')}${path}`,
      headers: { authorization: `Bearer ${await this.o.token()}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (res.status >= 200 && res.status < 300) return res.json<T>();
    const msg = (() => {
      try {
        return (res.json<{ error?: { message?: string } }>().error?.message) ?? `launcher answered ${res.status}`;
      } catch {
        return `launcher answered ${res.status}`;
      }
    })();
    if (res.status === 401 || res.status === 403) throw new PlatformError('auth', 'the runner launcher rejected our credentials');
    if (res.status === 404) throw new PlatformError('not-found', msg);
    if (res.status === 400 || res.status === 422) throw new PlatformError('validation', msg);
    if (res.status === 429 || res.status >= 500) throw new PlatformError('transient', msg);
    throw new PlatformError('validation', msg);
  }
}
