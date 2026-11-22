import { request, Agent } from 'undici';
import { PlatformError, tarUtf8File, type ContainerEngine, type ContainerState } from '@qa/domain';

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

  async inspectImage(ref: string) {
    const r = await this.call('GET', `/images/${encodeURIComponent(ref)}/json`);
    if (r.status === 404) return undefined;
    this.ok(r, 'inspect image');
    const id = (r.json as { Id?: string }).Id;
    return id ? { id } : undefined;
  }

  async logs(id: string): Promise<string> {
    // Work-item runs emit one RESULT_JSON line per case (plus browser noise). tail=20 dropped those lines
    // and left the worker with "The runner finished without case results."
    const res = await request(`${this.base}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=5000`, {
      method: 'GET',
      dispatcher: this.dispatcher,
      headersTimeout: 30_000,
      bodyTimeout: 120_000,
    });
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (res.statusCode === 404) return '';
    if (res.statusCode < 200 || res.statusCode >= 300) throw new PlatformError(res.statusCode >= 500 ? 'transient' : 'validation', `container engine refused logs (${res.statusCode})`);
    return dockerLogText(buf);
  }

  async list(labels: Record<string, string>) {
    const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }));
    const r = await this.call('GET', `/containers/json?all=true&filters=${filters}`);
    this.ok(r, 'list');
    const ids = (r.json as { Id: string }[]).map((c) => c.Id);
    const states = await Promise.all(ids.map((id) => this.inspect(id)));
    return states.filter((s): s is ContainerState => !!s);
  }

  /** Inject text files under an absolute directory (used for `/tmp/qa-cases.json` before start). */
  async putFiles(id: string, files: Array<{ path: string; content: string }>) {
    for (const file of files) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) || '/' : '/';
      const base = file.path.slice(file.path.lastIndexOf('/') + 1);
      const tar = tarUtf8File(base, file.content);
      try {
        const res = await request(`${this.base}/containers/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(dir)}`, {
          method: 'PUT',
          dispatcher: this.dispatcher,
          headers: { 'content-type': 'application/x-tar' },
          body: tar,
          headersTimeout: 30_000,
          bodyTimeout: 60_000,
        });
        await res.body.arrayBuffer();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new PlatformError(res.statusCode >= 500 ? 'transient' : 'validation', `container engine refused putFiles (${res.statusCode})`);
        }
      } catch (e) {
        if (e instanceof PlatformError) throw e;
        throw new PlatformError('transient', 'the container engine is not reachable', undefined, e);
      }
    }
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

/**
 * Docker's log stream frames each chunk with an 8-byte header.
 * Keep already-decoded frames when the last frame is truncated — falling back to the whole raw
 * buffer embeds binary headers and breaks RESULT_JSON parsing.
 */
export function dockerLogText(buf: Buffer): string {
  if (buf.length < 8) return buf.toString('utf8');
  const parts: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const stream = buf[i];
    const size = buf.readUInt32BE(i + 4);
    if (stream !== 1 && stream !== 2) {
      if (parts.length === 0) return buf.toString('utf8');
      parts.push(buf.subarray(i).toString('utf8'));
      break;
    }
    if (i + 8 + size > buf.length) {
      parts.push(buf.subarray(i + 8).toString('utf8'));
      break;
    }
    parts.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return parts.join('');
}
