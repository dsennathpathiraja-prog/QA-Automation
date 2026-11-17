import { request, Agent } from 'undici';
import { PlatformError, type ContainerEngine, type ContainerState } from '@qa/domain';

interface Inspect {
  Id: string;
  Name: string;
  State: { Status?: string; ExitCode?: number; StartedAt?: string; FinishedAt?: string; OOMKilled?: boolean };
  Config?: { Labels?: Record<string, string> };
}

const date = (s?: string) => (s && !s.startsWith('0001-') ? new Date(s) : undefined);

function toState(i: Inspect): ContainerState {
  return {
    id: i.Id,
    name: i.Name.replace(/^\//, ''),
    status: (i.State.Status as ContainerState['status']) ?? 'unknown',
    exitCode: i.State.ExitCode,
    startedAt: date(i.State.StartedAt),
    finishedAt: date(i.State.FinishedAt),
    oomKilled: i.State.OOMKilled,
    labels: i.Config?.Labels ?? {},
  };
}

/**
 * Docker Engine API over a unix socket (or a TCP address in tests). Only the launcher service may hold
 * the socket; the worker and API never do.
 */
export class DockerEngine implements ContainerEngine {
  private readonly dispatcher: Agent;
  private readonly base: string;

  constructor(o: { socketPath?: string; baseUrl?: string }) {
    this.dispatcher = new Agent(o.socketPath ? { connect: { socketPath: o.socketPath } } : {});
    this.base = o.socketPath ? 'http://docker' : (o.baseUrl ?? '').replace(/\/+$/, '');
  }

  async create(name: string, body: Record<string, unknown>) {
    const r = await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    if (r.status === 409) throw new PlatformError('conflict', 'a container with this name already exists');
    this.ok(r, 'create');
    return { id: (r.json as { Id: string }).Id };
  }

  async start(id: string) {
    const r = await this.call('POST', `/containers/${encodeURIComponent(id)}/start`);
    if (r.status !== 304) this.ok(r, 'start');
  }

  async inspect(idOrName: string) {
    const r = await this.call('GET', `/containers/${encodeURIComponent(idOrName)}/json`);
    if (r.status === 404) return undefined;
    this.ok(r, 'inspect');
    return toState(r.json as Inspect);
  }

  async stop(id: string, graceSeconds: number) {
    const r = await this.call('POST', `/containers/${encodeURIComponent(id)}/stop?t=${graceSeconds}`);
    if (r.status !== 304 && r.status !== 404) this.ok(r, 'stop');
  }

  async list(labels: Record<string, string>) {
    const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }));
    const r = await this.call('GET', `/containers/json?all=true&filters=${filters}`);
    this.ok(r, 'list');
    const ids = (r.json as { Id: string }[]).map((c) => c.Id);
    const states = await Promise.all(ids.map((id) => this.inspect(id)));
    return states.filter((s): s is ContainerState => !!s);
  }

  async close() {
    await this.dispatcher.close();
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown; text: string }> {
    try {
      const res = await request(`${this.base}${path}`, {
        method,
        dispatcher: this.dispatcher,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
      });
      const text = await res.body.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.statusCode, json, text };
    } catch (e) {
      throw new PlatformError('transient', 'the container engine is not reachable', undefined, e);
    }
  }

  private ok(r: { status: number; text: string }, what: string) {
    if (r.status >= 200 && r.status < 300) return;
    throw new PlatformError(r.status >= 500 ? 'transient' : 'validation', `container engine refused ${what} (${r.status})`);
  }
}
