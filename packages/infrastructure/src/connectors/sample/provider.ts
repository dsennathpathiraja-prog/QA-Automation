import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { CapabilityDescriptor, ConnectorClient, ConnectorProvider } from '@qa/connector-sdk';

export const SAMPLE_PROVIDER_KEY = 'sample-work-items';

const ConfigSchema = z.object({ projectName: z.string().min(1).max(60) });
const SecretSchema = z.object({ demoKey: z.string().min(8).max(200) });

const ITEMS = [
  { id: 'DEMO-1', title: 'Customer can check out with a saved card', description: 'As a shopper I can pay with a saved card.\n\nAcceptance criteria:\n- The saved card is listed at checkout\n- The order confirmation shows the last four digits' },
  { id: 'DEMO-2', title: 'Customer can reset a forgotten password', description: 'Acceptance criteria:\n- A reset email is sent\n- The link expires after one hour' },
];

/**
 * Offline demo provider. It makes no network calls, so the connector wizard, Test Connection and capability
 * table can be tried without any external system. A demo key must start with "demo-".
 */
export const sampleProvider: ConnectorProvider = {
  manifest: {
    providerKey: SAMPLE_PROVIDER_KEY,
    category: 'work-item',
    displayName: 'Sample work items (demo)',
    description: 'Built-in demo source of work items. Nothing leaves the platform. Use it to try the connector steps.',
    authMethods: [
      { key: 'demo_key', label: 'Demo key (any text starting with "demo-")', recommended: true, fields: [{ name: 'demoKey', label: 'Demo key', secret: true, required: true }] },
    ],
    capabilities: ['workitem.project.list', 'workitem.search', 'workitem.read'],
    requiredPermissions: ['None. This is a built-in demo.'],
    accessModePolicy: 'read_write',
    requiresInternet: false,
    verification: 'built-in',
    wizard: [
      { key: 'connection', title: 'Project', fields: [{ name: 'projectName', label: 'Demo project name', type: 'text', required: true }] },
      { key: 'credentials', title: 'Demo key', fields: [{ name: 'demoKey', label: 'Demo key', type: 'secret', required: true }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this source supports', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: SecretSchema,
  create(config, secrets) {
    const cfg = ConfigSchema.parse(config);
    const key = secrets ? SecretSchema.parse(secrets.value).demoKey : undefined;
    const valid = !!key?.startsWith('demo-');
    const client: ConnectorClient = {
      async testConnection() {
        return valid
          ? { ok: true, message: 'Connected to the demo source.', latencyMs: 1, discovered: { project: cfg.projectName, items: ITEMS.length } }
          : { ok: false, message: 'The demo key must start with "demo-".', latencyMs: 1 };
      },
      async probeCapabilities() {
        return [
          { capability: 'workitem.project.list', support: 'supported' as const },
          { capability: 'workitem.read', support: 'supported' as const },
          { capability: 'workitem.search', support: 'partial' as const, reason: 'The demo source matches titles only' },
        ];
      },
      async inspectPermissions() {
        return { granted: ['read'], writePermissionsDetected: [], notes: ['Demo source. Read only.'] };
      },
      async handle(cap: CapabilityDescriptor, input: unknown) {
        if (!valid) throw new PlatformError('auth', 'The demo key must start with "demo-".');
        const i = input as Record<string, string>;
        if (cap.id === 'workitem.project.list') return { items: [{ id: 'demo', name: cfg.projectName }] };
        if (cap.id === 'workitem.search') return { items: ITEMS.filter((w) => w.title.toLowerCase().includes((i.query ?? '').toLowerCase())).map(({ id, title }) => ({ id, title })) };
        if (cap.id === 'workitem.read') {
          const w = ITEMS.find((x) => x.id === i.id);
          if (!w) throw new PlatformError('not-found', 'work item not found');
          return w;
        }
        throw new PlatformError('unsupported', `The demo source does not implement ${cap.id}`);
      },
      dispose: async () => undefined,
    };
    return client;
  },
};
