import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createConnection, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const squid = spawnSync('which', ['squid']).stdout.toString().trim();
const confPath = resolve(__dirname, '../../../deploy/compose/squid/squid.conf');

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

const waitForPort = async (port: number) => {
  for (let i = 0; i < 60; i += 1) {
    const ok = await new Promise<boolean>((r) => {
      const c = createConnection(port, '127.0.0.1').once('connect', () => (c.destroy(), r(true))).once('error', () => r(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('squid did not start');
};

function viaProxy(proxyPort: number, url: string): Promise<number> {
  const u = new URL(url);
  return new Promise((res, rej) => {
    const r = request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: u.host } }, (resp) => (resp.resume(), res(resp.statusCode ?? 0)));
    r.on('error', rej).end();
  });
}

/** Runs the repository's real squid.conf; skipped where squid is not installed (CI installs it). */
describe.skipIf(!squid)('egress proxy (real squid, repository configuration)', () => {
  let dir: string;
  let origin: Server;
  let originPort: number;
  const procs: ChildProcess[] = [];

  async function startSquid(allowed: string[]): Promise<number> {
    const port = await freePort();
    const hostsFile = join(dir, `allowed-${port}.txt`);
    writeFileSync(hostsFile, allowed.map((h) => `${h}\n`).join(''));
    const conf = readFileSync(confPath, 'utf8')
      .replace('/etc/squid/allowed-hosts.txt', hostsFile)
      .replace('http_port 3128', `http_port 127.0.0.1:${port}`)
      .replace('access_log stdio:/dev/stdout', `access_log stdio:${join(dir, `access-${port}.log`)}`)
      .replace('cache_log /dev/stderr', `cache_log ${join(dir, `cache-${port}.log`)}`);
    const file = join(dir, `squid-${port}.conf`);
    writeFileSync(file, `${conf}\npid_filename ${join(dir, `squid-${port}.pid`)}\ncoredump_dir ${dir}\n`);
    procs.push(spawn(squid, ['-N', '-f', file], { stdio: 'ignore' }));
    await waitForPort(port);
    return port;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'squid-it-'));
    origin = createServer((_q, s) => s.end('ok'));
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    originPort = (origin.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const p of procs) p.kill('SIGKILL');
    origin?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('forwards an approved host and refuses every other host', async (ctx) => {
    // The policy only allows ports 80, 443, 8080 and 8443, so the positive case needs 8080 to be free.
    const approved = createServer((_q, s) => s.end('ok'));
    const bound = await new Promise<boolean>((r) => approved.once('error', () => r(false)).listen(8080, () => r(true)));
    try {
      const proxy = await startSquid(['localhost']);
      expect(await viaProxy(proxy, 'http://127.0.0.1:8080/'), 'unlisted host (by address)').toBe(403);
      expect(await viaProxy(proxy, 'http://blocked.example.invalid:8080/'), 'unlisted host').toBe(403);
      if (!bound) return ctx.skip();
      expect(await viaProxy(proxy, 'http://localhost:8080/'), 'listed host').toBe(200);
    } finally {
      if (bound) approved.close();
    }
  });

  it('refuses ports outside the allowed set even for an approved host', async () => {
    const proxy = await startSquid(['localhost']);
    expect(await viaProxy(proxy, `http://localhost:${originPort}/`)).toBe(403);
    expect(await viaProxy(proxy, `http://localhost:22/`)).toBe(403);
  });

  it('with an empty approved-host list (air-gapped) nothing is reachable', async () => {
    const proxy = await startSquid([]);
    expect(await viaProxy(proxy, `http://localhost:8080/`)).toBe(403);
  });
});
