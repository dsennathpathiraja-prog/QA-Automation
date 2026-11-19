import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LABEL, containerName, stateOf } from '@qa/domain';
import { DockerEngine, dockerLogText } from '../src';

interface Fake { id: string; name: string; body: any; status: string; exit: number }

/** A small Docker Engine API double on a real unix socket, so the socket code path is exercised. */
describe('docker log frames', () => {
  const frame = (text: string, stream = 1) => {
    const payload = Buffer.from(text);
    const head = Buffer.alloc(8);
    head[0] = stream;
    head.writeUInt32BE(payload.length, 4);
    return Buffer.concat([head, payload]);
  };

  it('joins framed stdout and leaves plain text alone', () => {
    expect(dockerLogText(Buffer.concat([frame('answered '), frame('200\n')]))).toBe('answered 200\n');
    expect(dockerLogText(Buffer.from('answered 200\n'))).toBe('answered 200\n');
  });

  it('keeps earlier frames when the last frame is truncated', () => {
    const first = frame('RESULT_JSON {"testCaseId":"a","status":"Passed"}\n');
    const partialHead = Buffer.alloc(8);
    partialHead[0] = 1;
    partialHead.writeUInt32BE(100, 4);
    const truncated = Buffer.concat([first, partialHead, Buffer.from('RESULT_JSON ')]);
    const text = dockerLogText(truncated);
    expect(text).toContain('RESULT_JSON {"testCaseId":"a"');
    expect(text).toContain('RESULT_JSON ');
  });
});

describe('DockerEngine over a unix socket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docker-fake-'));
  const socket = join(dir, 'docker.sock');
  const containers = new Map<string, Fake>();
  const requests: string[] = [];
  let server: Server;
  let engine: DockerEngine;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://docker');
      requests.push(`${req.method} ${url.pathname}`);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const send = (code: number, body?: unknown) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(body === undefined ? '' : JSON.stringify(body));
        };
        const inspect = (c: Fake) => ({ Id: c.id, Name: `/${c.name}`, State: { Status: c.status, ExitCode: c.exit, StartedAt: c.status === 'created' ? '0001-01-01T00:00:00Z' : '2026-11-17T10:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', OOMKilled: false }, Config: { Labels: c.body.Labels } });
        const find = (key: string) => [...containers.values()].find((c) => c.id === key || c.name === key);
        let m: RegExpMatchArray | null;
        if (req.method === 'POST' && url.pathname === '/containers/create') {
          const name = url.searchParams.get('name')!;
          if (find(name)) return send(409, { message: 'conflict' });
          const c: Fake = { id: `id-${containers.size + 1}`, name, body: JSON.parse(Buffer.concat(chunks).toString()), status: 'created', exit: 0 };
          containers.set(c.id, c);
          return send(201, { Id: c.id });
        }
        if (req.method === 'POST' && (m = url.pathname.match(/^\/containers\/([^/]+)\/start$/))) {
          const c = find(decodeURIComponent(m[1]!));
          if (!c) return send(404, {});
          if (c.status === 'running') return send(304);
          c.status = 'running';
          return send(204);
        }
        if (req.method === 'POST' && (m = url.pathname.match(/^\/containers\/([^/]+)\/stop$/))) {
          const c = find(decodeURIComponent(m[1]!));
          if (!c) return send(404, {});
          if (c.status !== 'running') return send(304);
          Object.assign(c, { status: 'exited', exit: 137 });
          return send(204);
        }
        if (req.method === 'GET' && (m = url.pathname.match(/^\/containers\/([^/]+)\/json$/))) {
          const c = find(decodeURIComponent(m[1]!));
          return c ? send(200, inspect(c)) : send(404, { message: 'no such container' });
        }
        if (req.method === 'GET' && url.pathname === '/containers/json') {
          const wanted: string[] = JSON.parse(url.searchParams.get('filters') ?? '{}').label ?? [];
          const items = [...containers.values()].filter((c) => wanted.every((w) => { const [k, v] = w.split('='); return c.body.Labels?.[k!] === v; }));
          return send(200, items.map((c) => ({ Id: c.id })));
        }
        return send(500, { message: `unexpected ${req.method} ${url.pathname}` });
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    engine = new DockerEngine({ socketPath: socket });
  });

  afterAll(async () => {
    await engine.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, starts, inspects, lists and stops through the engine API', async () => {
    const { id } = await engine.create(containerName('r1'), { Labels: { [LABEL.managed]: 'true', [LABEL.runId]: 'r1' }, Image: 'x' });
    expect((await engine.inspect(id))!.status).toBe('created');
    expect(stateOf((await engine.inspect(id))!).state).toBe('starting');
    await engine.start(id);
    await engine.start(id);
    const running = (await engine.inspect(containerName('r1')))!;
    expect(running).toMatchObject({ id, status: 'running', labels: { [LABEL.runId]: 'r1' } });
    expect(running.startedAt).toBeInstanceOf(Date);
    expect(running.finishedAt).toBeUndefined();
    expect((await engine.list({ [LABEL.managed]: 'true' })).map((c) => c.id)).toEqual([id]);
    expect(await engine.list({ [LABEL.runId]: 'other' })).toEqual([]);
    await engine.stop(id, 10);
    expect(stateOf((await engine.inspect(id))!)).toMatchObject({ state: 'failed', exitCode: 137 });
    await engine.stop(id, 10);
  });

  it('reports a name conflict and a missing container distinctly', async () => {
    await engine.create(containerName('dup'), { Labels: {} });
    await expect(engine.create(containerName('dup'), { Labels: {} })).rejects.toMatchObject({ errorClass: 'conflict' });
    expect(await engine.inspect('nope')).toBeUndefined();
  });

  it('turns an unreachable engine into a retryable error', async () => {
    const dead = new DockerEngine({ socketPath: join(dir, 'missing.sock') });
    await expect(dead.inspect('x')).rejects.toMatchObject({ errorClass: 'transient' });
    await dead.close();
  });

  it('maps exit states: success, failure and out-of-memory', () => {
    const base = { id: 'a', name: 'a', labels: {} };
    expect(stateOf({ ...base, status: 'exited', exitCode: 0 }).state).toBe('exited');
    expect(stateOf({ ...base, status: 'exited', exitCode: 2 }).state).toBe('failed');
    expect(stateOf({ ...base, status: 'exited', exitCode: 137, oomKilled: true })).toMatchObject({ state: 'failed', reason: 'out of memory' });
  });
});
