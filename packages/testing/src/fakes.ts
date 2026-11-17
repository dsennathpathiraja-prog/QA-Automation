import { z } from 'zod';
import {
  type AdapterDeps,
  type CallContext,
  type CapabilityDescriptor,
  type ConnectorClient,
  type ConnectorProvider,
  type ExecutionPolicy,
  type ExecutionPolicyStore,
  type InstanceResolver,
  type OperationLogEntry,
  type OperationLogSink,
  type ResolvedInstance,
  type CapabilityId,
  ConnectorExecutionManager,
  ProviderRegistry,
  createDefaultCapabilityRegistry,
} from '@qa/connector-sdk';
import { InMemorySecretStore } from '@qa/infrastructure';
import { SecretRedactor } from '@qa/security';
import { PlatformError, type Clock } from '@qa/domain';

export class InMemoryOperationLog implements OperationLogSink {
  readonly entries: OperationLogEntry[] = [];
  async append(e: OperationLogEntry) {
    this.entries.push(e);
  }
}

export class StaticInstanceResolver implements InstanceResolver {
  constructor(private readonly instances: Map<string, ResolvedInstance>) {}
  async getById(id: string) {
    return this.instances.get(id);
  }
}

export class StaticPolicyStore implements ExecutionPolicyStore {
  constructor(private readonly policies: Map<string, ExecutionPolicy>) {}
  async get(id: string) {
    return this.policies.get(id);
  }
}

export class FakeClock implements Clock {
  constructor(private t = Date.parse('2026-01-01T00:00:00Z')) {}
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export interface StubWorkItem {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
}

const emptyDeps: AdapterDeps = {
  http: {
    request: async () => {
      throw new Error('stub providers must not use the network');
    },
  },
};

/** In-memory work-item provider. `behavior` lets tests inject failures. */
export function makeStubWorkItemProvider(items: StubWorkItem[], behavior: { failWith?: PlatformError; sawToken?: { value?: string } } = {}): ConnectorProvider {
  const client: ConnectorClient = {
    testConnection: async () => ({ ok: true, message: 'stub ok' }),
    probeCapabilities: async () => [],
    inspectPermissions: async () => ({ granted: ['read'], writePermissionsDetected: [] }),
    async handle(cap: CapabilityDescriptor, input: unknown, _ctx: CallContext) {
      if (behavior.failWith) throw behavior.failWith;
      const i = input as Record<string, string>;
      if (cap.id === 'workitem.read') {
        const w = items.find((x) => x.id === i.id);
        if (!w) throw new PlatformError('not-found', 'work item not found');
        return w;
      }
      if (cap.id === 'workitem.search') {
        return { items: items.filter((x) => x.title.toLowerCase().includes((i.query ?? '').toLowerCase())).map(({ id, title }) => ({ id, title })) };
      }
      if (cap.id === 'workitem.project.list') return { items: [{ id: 'p1', name: 'Retail Web' }] };
      throw new PlatformError('unsupported', `stub does not implement ${cap.id}`);
    },
    dispose: async () => undefined,
  };
  return {
    manifest: {
      providerKey: 'stub-work-items',
      category: 'work-item',
      displayName: 'Stub work items',
      description: 'In-memory provider for tests',
      authMethods: [{ key: 'token', label: 'Token', recommended: true, fields: [{ name: 'token', label: 'Token', secret: true, required: true }] }],
      capabilities: ['workitem.project.list', 'workitem.search', 'workitem.read'],
      requiredPermissions: [],
      accessModePolicy: 'read_write',
      requiresInternet: false,
      wizard: [],
    },
    configSchema: z.object({}).passthrough(),
    secretSchema: z.object({ token: z.string() }),
    create: (_config, secrets) => {
      if (behavior.sawToken && secrets) behavior.sawToken.value = secrets.value.token;
      return client;
    },
  };
}

/** In-memory test-management provider with real create-if-absent semantics keyed by `reference`. */
export function makeStubTestManagementProvider(store: Map<string, { id: string; name: string }>, calls: { creates: number }): ConnectorProvider {
  const client: ConnectorClient = {
    testConnection: async () => ({ ok: true, message: 'stub ok' }),
    probeCapabilities: async () => [],
    inspectPermissions: async () => ({ granted: [], writePermissionsDetected: [] }),
    async handle(cap, input) {
      const i = input as { reference: string; name: string };
      if (cap.id === 'tm.testcase.upsert') {
        const existing = store.get(i.reference);
        if (existing) {
          existing.name = i.name;
          return { id: existing.id, created: false };
        }
        calls.creates += 1;
        const rec = { id: `TC-${store.size + 1}`, name: i.name };
        store.set(i.reference, rec);
        return { id: rec.id, created: true };
      }
      if (cap.id === 'tm.testcase.search') return { items: [] };
      throw new PlatformError('unsupported', cap.id);
    },
    dispose: async () => undefined,
  };
  return {
    manifest: {
      providerKey: 'stub-tm',
      category: 'test-management',
      displayName: 'Stub test management',
      description: 'In-memory provider for tests',
      authMethods: [],
      capabilities: ['tm.testcase.upsert', 'tm.testcase.search'],
      requiredPermissions: [],
      accessModePolicy: 'read_write',
      requiresInternet: false,
      wizard: [],
    },
    configSchema: z.object({}).passthrough(),
    secretSchema: z.object({}).passthrough(),
    create: () => client,
  };
}

export function makeInstance(over: Partial<ResolvedInstance> & { id: string; providerKey: string; category: ResolvedInstance['category'] }, caps: CapabilityId[]): ResolvedInstance {
  return {
    enabled: true,
    status: 'connected',
    accessMode: over.category === 'source-repo' ? 'read_only' : 'read_write',
    config: {},
    scope: {},
    effectiveCapabilities: new Set(caps),
    ...over,
  };
}

export interface Harness {
  manager: ConnectorExecutionManager;
  log: InMemoryOperationLog;
  secrets: InMemorySecretStore;
  redactor: SecretRedactor;
  clock: FakeClock;
}

export function createHarness(opts: {
  providers: ConnectorProvider[];
  instances: ResolvedInstance[];
  policies?: Record<string, ExecutionPolicy>;
  defaults?: ConstructorParameters<typeof ConnectorExecutionManager>[0]['defaults'];
}): Harness {
  const capabilities = createDefaultCapabilityRegistry();
  const providers = new ProviderRegistry(capabilities);
  for (const p of opts.providers) providers.register(p);
  const log = new InMemoryOperationLog();
  const clock = new FakeClock();
  const secrets = new InMemorySecretStore(clock);
  const redactor = new SecretRedactor();
  const manager = new ConnectorExecutionManager({
    capabilities,
    providers,
    instances: new StaticInstanceResolver(new Map(opts.instances.map((i) => [i.id, i]))),
    policies: new StaticPolicyStore(new Map(Object.entries(opts.policies ?? {}))),
    secrets,
    log,
    redactor,
    adapterDeps: emptyDeps,
    clock,
    defaults: opts.defaults,
  });
  return { manager, log, secrets, redactor, clock };
}

export const execPolicy = (over: Partial<ExecutionPolicy> = {}): ExecutionPolicy => ({
  capabilityDeny: [],
  boundRoles: {},
  agentGrants: {},
  ...over,
});
