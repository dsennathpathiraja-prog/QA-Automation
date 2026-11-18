import { describe, expect, it } from 'vitest';
import { buildProviders, buildSecretStore } from '../src';
import { freshDb } from '../../persistence/test/helpers';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('secret store selection', () => {
  it('has no store unless configured', () => {
    expect(buildSecretStore({}, 'development', undefined)).toBeUndefined();
  });

  it('refuses the database store in production and without a database or a 32-byte key', async () => {
    const { db } = await freshDb();
    expect(() => buildSecretStore({ SECRET_STORE: 'db-envelope', SECRET_MASTER_KEY: KEY }, 'production', db)).toThrow(/production/);
    expect(() => buildSecretStore({ SECRET_STORE: 'db-envelope', SECRET_MASTER_KEY: KEY }, 'development', undefined)).toThrow(/database/);
    expect(() => buildSecretStore({ SECRET_STORE: 'db-envelope' }, 'development', db)).toThrow(/SECRET_MASTER_KEY/);
    expect(() => buildSecretStore({ SECRET_STORE: 'db-envelope', SECRET_MASTER_KEY: Buffer.alloc(8).toString('base64') }, 'development', db)).toThrow(/32 bytes/);
    expect(() => buildSecretStore({ SECRET_STORE: 'nope' }, 'development', db)).toThrow(/Unknown/);
  });

  it('shares encrypted secrets between processes through the database', async () => {
    const { db, client } = await freshDb();
    const api = buildSecretStore({ SECRET_STORE: 'db-envelope', SECRET_MASTER_KEY: KEY }, 'development', db)!;
    const worker = buildSecretStore({ SECRET_STORE: 'db-envelope', SECRET_MASTER_KEY: KEY }, 'development', db)!;
    await api.store.put('connectors/c1/credentials', { token: 'tok-abcdef-123456' });
    const lease = await worker.store.lease('connectors/c1/credentials');
    expect(lease.value.token).toBe('tok-abcdef-123456');
    const raw = JSON.stringify((await client.query('select * from secret_envelope')).rows);
    expect(raw).not.toContain('tok-abcdef-123456');
  });

  it('selects OpenBao when BAO_ADDR is set and demands AppRole credentials', () => {
    expect(() => buildSecretStore({ BAO_ADDR: 'http://openbao:8200' }, 'production', undefined)).toThrow(/BAO_ROLE_ID_FILE/);
    expect(buildSecretStore({ BAO_ADDR: 'http://openbao:8200', BAO_ROLE_ID: 'r', BAO_SECRET_ID: 's' }, 'production', undefined)?.kind).toBe('openbao');
  });
});

describe('provider registry', () => {
  it('offers the demo provider outside production only, unless overridden', () => {
    const keys = (env: Record<string, string>, pe: 'development' | 'production') => buildProviders(env, pe).providers.all().map((p) => p.manifest.providerKey).sort();
    const always = ['azure-boards', 'azure-devops-repos', 'github', 'jira', 'playwright-mcp', 'squash-tm'].sort();
    expect(keys({}, 'development')).toEqual([...always, 'sample-work-items'].sort());
    expect(keys({}, 'production')).toEqual(always);
    expect(keys({ ENABLE_SAMPLE_PROVIDER: 'false' }, 'development')).toEqual(always);
  });
});
