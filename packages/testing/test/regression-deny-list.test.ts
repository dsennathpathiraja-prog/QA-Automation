import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ConnectorProvider } from '@qa/connector-sdk';
import { matchesPattern } from '@qa/connector-sdk';
import {
  createHarness,
  execPolicy,
  makeInstance,
  makeStubTestManagementProvider,
} from '../src';

/** Phase 9 Regression type deny-list (must match TYPE_SPECS['regression-testing'].deny). */
const REGRESSION_DENY = ['tm.testcase.upsert', 'scm.*', 'browser.*', 'agent.*'] as const;

const TM_CAPS = ['tm.testcase.upsert', 'tm.testcase.search', 'tm.testcase.read'] as const;
const SCM_CAPS = ['scm.file.read', 'scm.tree.list', 'scm.code.search'] as const;
const BROWSER_CAPS = ['browser.session.open', 'browser.navigate', 'browser.snapshot'] as const;

function makeStubSourceRepoProvider(): ConnectorProvider {
  return {
    manifest: {
      providerKey: 'stub-repo',
      category: 'source-repo',
      displayName: 'Stub repo',
      description: 'test',
      authMethods: [],
      capabilities: [...SCM_CAPS],
      requiredPermissions: [],
      accessModePolicy: 'read_only_enforced',
      requiresInternet: false,
      verification: 'live-capable',
      wizard: [],
    },
    configSchema: z.object({ repo: z.string().optional() }),
    secretSchema: z.object({}),
    create: () => ({
      testConnection: async () => ({ ok: true, message: '' }),
      probeCapabilities: async () => [],
      inspectPermissions: async () => ({ granted: [], writePermissionsDetected: [] }),
      handle: async (cap) => {
        if (cap.id === 'scm.file.read') return { path: 'x.ts', content: '', truncated: false };
        if (cap.id === 'scm.tree.list') return { entries: [] };
        if (cap.id === 'scm.code.search') return { items: [] };
        throw new Error(cap.id);
      },
      dispose: async () => undefined,
    }),
  };
}

function makeStubBrowserProvider(): ConnectorProvider {
  return {
    manifest: {
      providerKey: 'stub-browser',
      category: 'browser-automation',
      displayName: 'Stub browser',
      description: 'test',
      authMethods: [],
      capabilities: [...BROWSER_CAPS],
      requiredPermissions: [],
      accessModePolicy: 'read_write',
      requiresInternet: true,
      verification: 'live-capable',
      wizard: [],
    },
    configSchema: z.object({}).passthrough(),
    secretSchema: z.object({}),
    create: () => ({
      testConnection: async () => ({ ok: true, message: '' }),
      probeCapabilities: async () => [],
      inspectPermissions: async () => ({ granted: [], writePermissionsDetected: [] }),
      handle: async (cap) => {
        if (cap.id === 'browser.session.open') return { sessionId: 's1' };
        if (cap.id === 'browser.navigate') return { finalUrl: 'https://example.test/' };
        if (cap.id === 'browser.snapshot') return { accessibilityTree: '', url: 'https://example.test/' };
        throw new Error(cap.id);
      },
      dispose: async () => undefined,
    }),
  };
}

function deniedByRegressionPolicy(capability: string): boolean {
  return REGRESSION_DENY.some((pattern) => matchesPattern(pattern, capability));
}

describe('Regression execution deny-list (Phase 9 E6)', () => {
  it('denies upsert / scm / browser under Regression policy and never logs them as ok', async () => {
    const store = new Map<string, { id: string; name: string }>();
    const h = createHarness({
      providers: [
        makeStubTestManagementProvider(store, { creates: 0 }),
        makeStubSourceRepoProvider(),
        makeStubBrowserProvider(),
      ],
      instances: [
        makeInstance({ id: 'tm1', providerKey: 'stub-tm', category: 'test-management' }, [...TM_CAPS]),
        makeInstance(
          { id: 'repo1', providerKey: 'stub-repo', category: 'source-repo', config: { repo: 'org/app' }, accessMode: 'read_only' },
          [...SCM_CAPS],
        ),
        makeInstance({ id: 'br1', providerKey: 'stub-browser', category: 'browser-automation' }, [...BROWSER_CAPS]),
      ],
      policies: {
        rg1: execPolicy({
          capabilityDeny: [...REGRESSION_DENY],
          boundRoles: { testManagement: 'tm1', sourceRepo: 'repo1', browserAutomation: 'br1' },
          agentGrants: { planner: [{ capability: 'tm.testcase.read' }] },
        }),
      },
    });

    const step = { type: 'step' as const, id: 'rg.execute-tests', executionId: 'rg1', stepId: 'execute' };
    const attempts: { role: string; capability: string; input: Record<string, unknown>; idempotencyKey?: string }[] = [
      { role: 'testManagement', capability: 'tm.testcase.upsert', input: { reference: 'QAP-1', name: 'x' }, idempotencyKey: 'k1' },
      { role: 'sourceRepo', capability: 'scm.file.read', input: { repo: 'org/app', path: 'a.ts' } },
      { role: 'sourceRepo', capability: 'scm.tree.list', input: { repo: 'org/app' } },
      { role: 'sourceRepo', capability: 'scm.code.search', input: { repo: 'org/app', query: 'checkout' } },
      { role: 'browserAutomation', capability: 'browser.session.open', input: {} },
      { role: 'browserAutomation', capability: 'browser.navigate', input: { sessionId: 's1', url: 'https://example.test/' } },
      { role: 'browserAutomation', capability: 'browser.snapshot', input: { sessionId: 's1' } },
    ];

    for (const a of attempts) {
      await expect(
        h.manager.invoke({
          role: a.role,
          capability: a.capability,
          input: a.input,
          idempotencyKey: a.idempotencyKey,
          actor: step,
        }),
      ).rejects.toMatchObject({ errorClass: 'denied' });
    }

    // Allowed Regression TM search still succeeds (proves the harness is live).
    await expect(
      h.manager.invoke({
        role: 'testManagement',
        capability: 'tm.testcase.search',
        input: {},
        actor: step,
      }),
    ).resolves.toMatchObject({ items: [] });

    // Agent grant cannot bypass the deny-list for upsert / explore families.
    const agent = { type: 'agent' as const, id: 'planner', agentKey: 'planner', executionId: 'rg1', stepId: 'execute' };
    await expect(
      h.manager.invoke({
        role: 'testManagement',
        capability: 'tm.testcase.upsert',
        input: { reference: 'QAP-2', name: 'y' },
        idempotencyKey: 'k2',
        actor: agent,
      }),
    ).rejects.toMatchObject({ errorClass: 'denied' });

    const okDeniedFamily = h.log.entries.filter(
      (e) => e.outcome === 'ok' && deniedByRegressionPolicy(e.capability),
    );
    expect(okDeniedFamily).toEqual([]);

    const deniedCaps = h.log.entries.filter((e) => e.outcome === 'denied').map((e) => e.capability);
    expect(deniedCaps).toEqual(expect.arrayContaining([
      'tm.testcase.upsert',
      'scm.file.read',
      'scm.tree.list',
      'scm.code.search',
      'browser.session.open',
      'browser.navigate',
      'browser.snapshot',
    ]));
    for (const cap of deniedCaps) {
      expect(deniedByRegressionPolicy(cap) || cap === 'tm.testcase.upsert').toBe(true);
    }

    // Policy advertises agent.* even though no agent.* capabilities exist yet.
    expect(REGRESSION_DENY).toContain('agent.*');
    expect(matchesPattern('agent.*', 'agent.plan')).toBe(true);
    expect(h.log.entries.some((e) => e.outcome === 'ok' && matchesPattern('agent.*', e.capability))).toBe(false);
  });
});
