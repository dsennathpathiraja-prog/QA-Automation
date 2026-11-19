import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../apps/runner/check.mjs', import.meta.url));
const servers: Server[] = [];

afterEach(() => servers.splice(0).forEach((s) => s.close()));

function run(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, out }));
  });
}

describe('runner image program', () => {
  it('answers 0 when the allowed host responds', async () => {
    const server = createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const result = await run({ QA_TARGET_URL: `http://127.0.0.1:${port}/health`, QA_ALLOWED_HOSTS: '127.0.0.1' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('answered 200');
  });

  it('refuses a host that was not allowed', async () => {
    const result = await run({ QA_TARGET_URL: 'https://qa.shop.example', QA_ALLOWED_HOSTS: 'other.example' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('host not allowed');
  });

  it('answers 1 when the application returns a server error', async () => {
    const server = createServer((_req, res) => { res.statusCode = 503; res.end(); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const result = await run({ QA_TARGET_URL: `http://127.0.0.1:${port}/`, QA_ALLOWED_HOSTS: `127.0.0.1:${port}` });
    expect(result.code).toBe(1);
    expect(result.out).toContain('answered 503');
  });
});
