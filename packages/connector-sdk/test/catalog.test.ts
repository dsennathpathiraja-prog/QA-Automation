import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CapabilityRegistry, ProviderRegistry, createDefaultCapabilityRegistry, matchesPattern, type ConnectorProvider } from '../src';

const base = { version: 1, risk: 'low' as const, input: z.object({}), output: z.object({}) };

describe('capability catalog', () => {
  it('default catalog registers and every source-repo capability is read-only', () => {
    const r = createDefaultCapabilityRegistry();
    const repo = r.byCategory('source-repo');
    expect(repo.length).toBeGreaterThan(0);
    expect(repo.every((c) => c.access === 'read')).toBe(true);
  });

  it('rejects a write capability in the source-repo category', () => {
    const r = new CapabilityRegistry();
    expect(() => r.register({ ...base, id: 'scm.file.write', category: 'source-repo', access: 'write', idempotent: 'natural' })).toThrow(/cannot declare write/);
    expect(() => r.register({ ...base, id: 'scm.push', category: 'source-repo', access: 'write', idempotent: 'key-required' })).toThrow(/cannot declare write/);
  });

  it('requires write capabilities to declare idempotency', () => {
    const r = new CapabilityRegistry();
    expect(() => r.register({ ...base, id: 'tm.x.write', category: 'test-management', access: 'write' })).toThrow(/idempotency/);
  });

  it('no default capability resembles a git write operation', () => {
    const ids = createDefaultCapabilityRegistry().all().map((c) => c.id);
    expect(ids.filter((id) => /commit\.(create|push)|push|pull_request|pr\.|branch\.(create|delete)|merge/.test(id))).toEqual([]);
  });

  it('wildcard patterns match by namespace prefix', () => {
    expect(matchesPattern('scm.*', 'scm.file.read')).toBe(true);
    expect(matchesPattern('scm.*', 'tm.testcase.upsert')).toBe(false);
    expect(matchesPattern('tm.testcase.upsert', 'tm.testcase.upsert')).toBe(true);
    expect(matchesPattern('tm.testcase.upsert', 'tm.testcase.read')).toBe(false);
  });
});

describe('provider registry', () => {
  const caps = createDefaultCapabilityRegistry();
  const provider = (over: Partial<ConnectorProvider['manifest']>): ConnectorProvider => ({
    manifest: {
      providerKey: 'p', category: 'source-repo', displayName: 'P', description: 'd', authMethods: [], capabilities: ['scm.file.read'],
      requiredPermissions: [], accessModePolicy: 'read_only_enforced', requiresInternet: false, wizard: [], ...over,
    },
    configSchema: z.object({}),
    secretSchema: z.object({}),
    create: () => { throw new Error('unused'); },
  });

  it('accepts a valid read-only repo provider', () => {
    expect(() => new ProviderRegistry(caps).register(provider({}))).not.toThrow();
  });

  it('rejects source-repo providers that are not read_only_enforced', () => {
    expect(() => new ProviderRegistry(caps).register(provider({ accessModePolicy: 'read_write' }))).toThrow(/read_only_enforced/);
  });

  it('rejects capabilities from another category', () => {
    expect(() => new ProviderRegistry(caps).register(provider({ capabilities: ['tm.testcase.upsert'] }))).toThrow(/category/);
  });

  it('rejects unknown capabilities and duplicates', () => {
    const r = new ProviderRegistry(caps);
    expect(() => r.register(provider({ capabilities: ['scm.nope'] }))).toThrow(/Unknown capability/);
    r.register(provider({}));
    expect(() => r.register(provider({}))).toThrow(/already registered/);
  });
});
