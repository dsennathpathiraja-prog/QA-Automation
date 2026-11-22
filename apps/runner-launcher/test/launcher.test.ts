import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LABEL, enforceTimeouts, toDockerCreateBody } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, RemoteRunnerLauncher, type EgressRule } from '@qa/infrastructure';
import { FakeContainerEngine, runnerLauncherContract, sampleRunnerSpec } from '@qa/testing';
import { buildLauncherApp } from '../src';

const TOKEN = 't'.repeat(32);
const translate = { network: 'automation', proxyUrl: 'http://egress-proxy:3128' };
const deps = (engine: FakeContainerEngine, over = {}) => ({ engine, token: TOKEN, translate, allowedImagePrefixes: ['registry.local/qa/'], maxConcurrent: 3, ...over });
const auth = { authorization: `Bearer ${TOKEN}` };

describe('hardening of every runner container', () => {
  const body = toDockerCreateBody(sampleRunnerSpec({ env: { BASE_URL: 'https://shop.staging.example.com' }, authMaterialRef: 'runs/r1/auth' }), translate) as any;

  it('drops all privileges and isolates the filesystem', () => {
    const h = body.HostConfig;
    expect(h).toMatchObject({ Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], NetworkMode: 'automation', AutoRemove: false, PublishAllPorts: false });
    expect(h.Binds).toBeUndefined();
    expect(h.Mounts).toBeUndefined();
    expect(h.PidMode).toBeUndefined();
    expect(h.IpcMode).toBeUndefined();
    expect(h.Devices).toBeUndefined();
    expect(body.User).toBe('1000:1000');
  });

  it('bounds memory, swap, CPU and processes from the spec', () => {
    expect(body.HostConfig).toMatchObject({ Memory: 2048 * 1024 * 1024, MemorySwap: 2048 * 1024 * 1024, NanoCpus: 2e9, PidsLimit: 512 });
  });

  it('labels the container as platform-managed and passes the time limit', () => {
    expect(body.Labels).toMatchObject({ [LABEL.managed]: 'true', [LABEL.runId]: 'run-1', [LABEL.timeoutSeconds]: '1800' });
  });

  it('sends only references and plain settings, and routes traffic through the egress proxy', () => {
    const env = Object.fromEntries((body.Env as string[]).map((e) => e.split(/=(.*)/s).slice(0, 2)));
    expect(env).toMatchObject({ QA_RUN_ID: 'run-1', QA_AUTH_MATERIAL_REF: 'runs/r1/auth', QA_ALLOWED_HOSTS: 'shop.staging.example.com', HTTPS_PROXY: 'http://egress-proxy:3128' });
  });

  it('refuses to translate an invalid spec', () => {
    expect(() => toDockerCreateBody(sampleRunnerSpec({ image: 'playwright:latest' }), translate)).toThrow(/pinned by digest/);
  });
});

describe('runner launcher service', () => {
  it('requires the bearer token on everything except health', async () => {
    const app = buildLauncherApp(deps(new FakeContainerEngine()));
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    expect((await app.inject('/v1/runners')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/runners', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/runners', headers: auth })).statusCode).toBe(200);
  });

  it('launches a hardened container and starts it', async () => {
    const engine = new FakeContainerEngine();
    const app = buildLauncherApp(deps(engine));
    const r = await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec() });
    expect(r.statusCode).toBe(201);
    expect(engine.created[0]!.name).toBe('qa-runner-run-1');
    expect((engine.created[0]!.body as any).HostConfig.CapDrop).toEqual(['ALL']);
    expect([...engine.containers.values()][0]!.state.status).toBe('running');
  });

  it('injects inlineFiles into the container before start', async () => {
    const engine = new FakeContainerEngine();
    const app = buildLauncherApp(deps(engine));
    const cases = JSON.stringify([{ id: 'a', name: 'Login', steps: ['Open page', 'Capture evidence'] }]);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/runners',
      headers: auth,
      payload: sampleRunnerSpec({
        env: { QA_CASES_FILE: '/tmp/qa-cases.json' },
        inlineFiles: [{ path: '/tmp/qa-cases.json', content: cases }],
      }),
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    expect(engine.files.get(id)).toEqual([{ path: '/tmp/qa-cases.json', content: cases }]);
    expect([...engine.containers.values()][0]!.state.status).toBe('running');
  });

  it('returns the existing runner for a repeated runId, also when creation races', async () => {
    const engine = new FakeContainerEngine();
    const app = buildLauncherApp(deps(engine));
    const first = (await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec() })).json();
    const again = await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec() });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
    expect(engine.created).toHaveLength(1);
  });

  it('rejects invalid specs with the list of problems, and images from unapproved registries', async () => {
    const app = buildLauncherApp(deps(new FakeContainerEngine()));
    const bad = await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ allowedHosts: [], image: 'latest' }) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.problems.length).toBeGreaterThanOrEqual(2);
    const foreign = await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ image: `docker.io/evil/miner@sha256:${'b'.repeat(64)}` }) });
    expect(foreign.statusCode).toBe(403);
  });

  it('applies back-pressure when the pool is full', async () => {
    const app = buildLauncherApp(deps(new FakeContainerEngine(), { maxConcurrent: 1 }));
    expect((await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ runId: 'a' }) })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ runId: 'b' }) })).statusCode).toBe(429);
  });

  it('cannot see, stop or list containers the platform did not create', async () => {
    const engine = new FakeContainerEngine();
    engine.add({ id: 'db-1', name: 'postgres', status: 'running', labels: {} });
    const app = buildLauncherApp(deps(engine));
    expect((await app.inject({ method: 'GET', url: '/v1/runners/db-1', headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/runners/db-1/stop', headers: auth, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/runners', headers: auth })).json().items).toEqual([]);
    expect(engine.containers.get('db-1')!.state.status).toBe('running');
  });

  it('pins a local image to the engine id and refuses any other digest', async () => {
    const engine = new FakeContainerEngine();
    const digest = 'c'.repeat(64);
    engine.images.set('qa-runner:local', { id: `sha256:${digest}` });
    const app = buildLauncherApp(deps(engine, { allowedImagePrefixes: ['qa-runner@'], localImage: { repository: 'qa-runner', ref: 'qa-runner:local' } }));
    const pin = `qa-runner@sha256:${digest}`;
    expect((await app.inject({ method: 'GET', url: '/v1/runner-image', headers: auth })).json()).toEqual({ image: pin });
    const ok = await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ image: pin, allowedHosts: ['qa.shop.example'] }) });
    expect(ok.statusCode).toBe(201);
    expect(engine.created[0]!.body.Image).toBe(`sha256:${digest}`);
    const other = await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ runId: 'other', image: `qa-runner@sha256:${'d'.repeat(64)}` }) });
    expect(other.statusCode).toBe(403);
  });

  it('stops runners that outlive their time limit and leaves the others alone', async () => {
    const engine = new FakeContainerEngine();
    const app = buildLauncherApp(deps(engine));
    await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ runId: 'old', limits: { cpus: 1, memoryMb: 512, timeoutSeconds: 60, pids: 64 } }) });
    await app.inject({ method: 'POST', url: '/v1/runners', headers: auth, payload: sampleRunnerSpec({ runId: 'new' }) });
    const stopped = await enforceTimeouts(engine, new Date(Date.now() + 61_000));
    expect(stopped).toEqual(['old']);
    const states = Object.fromEntries([...engine.containers.values()].map((c) => [c.state.labels[LABEL.runId], c.state.status]));
    expect(states).toEqual({ old: 'exited', new: 'running' });
  });
});

describe('RemoteRunnerLauncher against the real service over HTTP', () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((s) => s.close()));

  async function remote(token: string) {
    const engine = new FakeContainerEngine();
    const app = buildLauncherApp(deps(engine));
    await app.ready();
    const server = createServer((req, res) => app.routing(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const rules: EgressRule[] = [{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }];
    const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile: 'standard', platformEnv: 'development' }), allowedMethods: ['GET', 'POST'] });
    return { launcher: new RemoteRunnerLauncher({ baseUrl: `http://127.0.0.1:${port}`, token: () => token, http }), engine };
  }

  runnerLauncherContract('RemoteRunnerLauncher -> service -> fake engine', async () => {
    const { launcher, engine } = await remote(TOKEN);
    return {
      launcher,
      finish: (id, code) => {
        const c = [...engine.containers.values()].find((x) => x.state.id === id)!;
        Object.assign(c.state, { status: 'exited', exitCode: code, finishedAt: new Date() });
      },
    };
  });

  it('reports a rejected token as an auth error', async () => {
    const { launcher } = await remote('x'.repeat(32));
    await expect(launcher.list({})).rejects.toMatchObject({ errorClass: 'auth' });
  });
});
