import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbEnvelopeSecretStore, InMemoryEnvelopeRows, InMemorySecretStore, LocalFsObjectStore, OpenBaoSecretStore, assertLocator,
} from '../src';

describe('secret locators', () => {
  it('rejects traversal and malformed locators', () => {
    for (const bad of ['', '../x', 'a/../b', '/abs', 'a//b', 'a/', 'a b', 'x'.repeat(300)]) expect(() => assertLocator(bad)).toThrow();
    expect(() => assertLocator('connectors/abc-123/token')).not.toThrow();
  });
});

describe('InMemorySecretStore', () => {
  it('versions values and wipes released leases', async () => {
    const s = new InMemorySecretStore();
    expect((await s.put('a/b', { k: 'v1' })).version).toBe(1);
    expect((await s.put('a/b', { k: 'v2' })).version).toBe(2);
    const lease = await s.lease('a/b');
    expect(lease.value.k).toBe('v2');
    lease.release();
    expect(() => lease.value).toThrow(/released/);
    await expect(s.lease('a/missing')).rejects.toMatchObject({ errorClass: 'not-found' });
  });
});

describe('DbEnvelopeSecretStore', () => {
  const key = Buffer.alloc(32, 7);
  it('round-trips and stores no plaintext', async () => {
    const rows = new InMemoryEnvelopeRows();
    const s = new DbEnvelopeSecretStore(rows, key, 'test');
    await s.put('connectors/c1/token', { token: 'plain-secret-value' });
    expect(JSON.stringify([...rows.rows.values()])).not.toContain('plain-secret-value');
    const l = await s.lease('connectors/c1/token');
    expect(l.value.token).toBe('plain-secret-value');
  });
  it('detects tampering and wrong keys', async () => {
    const rows = new InMemoryEnvelopeRows();
    const s = new DbEnvelopeSecretStore(rows, key, 'test');
    await s.put('x/y', { a: 'b' });
    const row = rows.rows.get('x/y')!;
    rows.rows.set('x/y', { ...row, locator: 'x/y', ciphertext: Buffer.from('tampered-ciphertext').toString('base64') });
    await expect(s.lease('x/y')).rejects.toMatchObject({ errorClass: 'internal' });
    rows.rows.set('x/y', row);
    await expect(new DbEnvelopeSecretStore(rows, Buffer.alloc(32, 9), 'test').lease('x/y')).rejects.toBeTruthy();
    await expect(s.lease('x/y')).resolves.toBeTruthy();
  });
  it('binds ciphertext to its locator (no row swapping)', async () => {
    const rows = new InMemoryEnvelopeRows();
    const s = new DbEnvelopeSecretStore(rows, key, 'test');
    await s.put('a/one', { v: '1' });
    await s.put('a/two', { v: '2' });
    rows.rows.set('a/two', { ...rows.rows.get('a/one')!, locator: 'a/two' });
    await expect(s.lease('a/two')).rejects.toBeTruthy();
  });
  it('refuses to exist in production', () => {
    expect(() => new DbEnvelopeSecretStore(new InMemoryEnvelopeRows(), key, 'production')).toThrow(/production/);
  });
});

describe('OpenBaoSecretStore against a KV v2 fake with policies', () => {
  let srv: Server;
  let addr = '';
  const kv = new Map<string, { version: number; data: Record<string, string> }>();
  const logins: string[] = [];
  const policyOf = new Map<string, 'api' | 'worker'>();

  beforeAll(async () => {
    srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const send = (status: number, json?: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(json === undefined ? '' : JSON.stringify(json));
        };
        const url = req.url ?? '';
        if (url === '/v1/auth/approle/login') {
          const b = JSON.parse(body) as { role_id: string; secret_id: string };
          if (b.secret_id !== 'good') return send(400, { errors: ['invalid'] });
          const token = `tok-${b.role_id}`;
          logins.push(b.role_id);
          policyOf.set(token, b.role_id === 'api' ? 'api' : 'worker');
          return send(200, { auth: { client_token: token, lease_duration: 3600 } });
        }
        const pol = policyOf.get(String(req.headers['x-vault-token']));
        if (!pol) return send(403, { errors: ['permission denied'] });
        const m = /^\/v1\/qa-platform\/(data|metadata)\/(.+)$/.exec(url);
        if (!m) return send(404);
        const [, kind, path] = m as unknown as [string, string, string];
        if (req.method === 'POST' && kind === 'data') {
          const v = (kv.get(path)?.version ?? 0) + 1;
          kv.set(path, { version: v, data: (JSON.parse(body) as { data: Record<string, string> }).data });
          return send(200, { data: { version: v } });
        }
        if (req.method === 'GET' && kind === 'data') {
          if (pol === 'api') return send(403, { errors: ['permission denied'] });
          const e = kv.get(path);
          return e ? send(200, { data: { data: e.data, metadata: { version: e.version } } }) : send(404);
        }
        if (req.method === 'GET' && kind === 'metadata') return kv.has(path) ? send(200, { data: {} }) : send(404);
        if (req.method === 'DELETE' && kind === 'metadata') {
          kv.delete(path);
          return send(204);
        }
        return send(404);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    addr = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  });
  afterAll(() => srv.close());

  const store = (role: 'api' | 'worker', secretId = 'good') => new OpenBaoSecretStore({ addr, auth: { type: 'approle', roleId: role, secretId } });

  it('api can write but not read; worker can read', async () => {
    const api = store('api');
    const worker = store('worker');
    expect((await api.put('connectors/c1/token', { token: 't-1' })).version).toBe(1);
    await expect(api.lease('connectors/c1/token')).rejects.toMatchObject({ errorClass: 'denied' });
    const lease = await worker.lease('connectors/c1/token');
    expect(lease.value.token).toBe('t-1');
    expect(await worker.exists('connectors/c1/token')).toBe(true);
    expect(await worker.exists('connectors/none')).toBe(false);
    await worker.delete('connectors/c1/token');
    await expect(worker.lease('connectors/c1/token')).rejects.toMatchObject({ errorClass: 'not-found' });
  });

  it('caches the login token and surfaces login failure as auth', async () => {
    const before = logins.filter((l) => l === 'worker').length;
    const w = store('worker');
    await w.put('x/a', { a: '1' });
    await w.lease('x/a');
    expect(logins.filter((l) => l === 'worker').length - before).toBe(1);
    await expect(store('worker', 'bad').exists('x/a')).rejects.toMatchObject({ errorClass: 'auth' });
  });
});

describe('LocalFsObjectStore', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qa-os-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('stores, hashes, lists and deletes objects', async () => {
    const s = new LocalFsObjectStore(dir);
    const meta = await s.put('executions/e1/user-stories/US-1.md', new TextEncoder().encode('# story'));
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(await s.get('executions/e1/user-stories/US-1.md'))).toBe('# story');
    await s.put('executions/e2/x.txt', new Uint8Array([1]));
    expect((await s.list('executions/e1/')).map((o) => o.key)).toEqual(['executions/e1/user-stories/US-1.md']);
    expect((await s.head('executions/e1/user-stories/US-1.md'))?.size).toBe(7);
    await s.delete('executions/e2/x.txt');
    expect(await s.head('executions/e2/x.txt')).toBeUndefined();
    await expect(s.get('nope')).rejects.toMatchObject({ errorClass: 'not-found' });
  });

  it('rejects path traversal and absolute keys', async () => {
    const s = new LocalFsObjectStore(dir);
    for (const k of ['../escape', 'a/../../escape', '/etc/passwd', '']) {
      await expect(s.put(k, new Uint8Array([1]))).rejects.toMatchObject({ errorClass: 'validation' });
    }
  });

  it('leaves no temp files behind', async () => {
    const s = new LocalFsObjectStore(dir);
    await s.put('tmpcheck/a.bin', new Uint8Array([1, 2]));
    expect((await readdir(join(dir, 'tmpcheck'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
