import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenBaoSecretStore } from '../src';

const addr = process.env.TEST_OPENBAO_ADDR;
const rootToken = process.env.TEST_OPENBAO_ROOT_TOKEN ?? 'root-test';
const policyDir = resolve(__dirname, '../../../deploy/compose/openbao/policies');

async function admin(method: string, path: string, body?: unknown, allow: number[] = [200, 204]) {
  const res = await fetch(`${addr}/v1/${path}`, { method, headers: { 'x-vault-token': rootToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!allow.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? {} : ((await res.json()) as any);
}

/**
 * Runs the repository's real policy files against a real OpenBao (dev server in CI or locally):
 *   bao server -dev -dev-root-token-id=root-test    then    TEST_OPENBAO_ADDR=http://127.0.0.1:8200
 */
describe.skipIf(!addr)('OpenBao least-privilege policies (real server)', () => {
  const stores: Record<'api' | 'worker' | 'launcher', OpenBaoSecretStore> = {} as never;

  beforeAll(async () => {
    await admin('POST', 'sys/mounts/qa-platform', { type: 'kv', options: { version: '2' } }, [200, 204, 400]);
    await admin('POST', 'sys/auth/approle', { type: 'approle' }, [200, 204, 400]);
    const roles = { api: 'qa-api', worker: 'qa-worker', launcher: 'qa-runner-launcher' } as const;
    for (const [key, role] of Object.entries(roles)) {
      await admin('PUT', `sys/policies/acl/${role}`, { policy: readFileSync(resolve(policyDir, `${role}.hcl`), 'utf8') });
      await admin('POST', `auth/approle/role/${role}`, { token_policies: role, token_ttl: '15m' });
      const roleId = (await admin('GET', `auth/approle/role/${role}/role-id`)).data.role_id as string;
      const secretId = (await admin('POST', `auth/approle/role/${role}/secret-id`, {})).data.secret_id as string;
      stores[key as keyof typeof stores] = new OpenBaoSecretStore({ addr: addr!, auth: { type: 'approle', roleId, secretId } });
    }
  });

  it('lets the api write a connector secret but never read it back', async () => {
    const written = await stores.api.put('connectors/it-1/token', { token: 'never-readable-by-api' });
    expect(written.version).toBeGreaterThanOrEqual(1);
    await expect(stores.api.lease('connectors/it-1/token')).rejects.toMatchObject({ errorClass: 'denied' });
    expect(await stores.api.exists('connectors/it-1/token')).toBe(true);
    expect(await stores.api.exists('connectors/it-missing/token')).toBe(false);
  });

  it('lets the worker read connector secrets but not write them', async () => {
    const lease = await stores.worker.lease('connectors/it-1/token');
    expect(lease.value).toEqual({ token: 'never-readable-by-api' });
    lease.release();
    await expect(stores.worker.put('connectors/it-2/token', { token: 'x' })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('limits the runner launcher to environment credentials', async () => {
    await stores.api.put('environments/it-env/login', { username: 'qa', password: 'pw' });
    const lease = await stores.launcher.lease('environments/it-env/login');
    expect(lease.value.username).toBe('qa');
    await expect(stores.launcher.lease('connectors/it-1/token')).rejects.toMatchObject({ errorClass: 'denied' });
    await expect(stores.launcher.put('environments/it-env/login', { username: 'x' })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('keeps platform-owned secrets out of reach of the api', async () => {
    await expect(stores.api.put('platform/database', { password: 'x' })).rejects.toMatchObject({ errorClass: 'denied' });
    await expect(stores.api.lease('platform/database')).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('removes a secret for everyone when the api deletes it', async () => {
    await stores.api.delete('connectors/it-1/token');
    await expect(stores.worker.lease('connectors/it-1/token')).rejects.toMatchObject({ errorClass: 'not-found' });
    expect(await stores.api.exists('connectors/it-1/token')).toBe(false);
  });
});
