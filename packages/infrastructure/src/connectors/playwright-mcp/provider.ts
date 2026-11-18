import { z } from 'zod';
import { PlatformError } from '@qa/domain';
import type { AdapterDeps, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { joinUrl, requestJson, required } from '../rest';

export const PLAYWRIGHT_PROVIDER_KEY = 'playwright-mcp';

const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  /** Comma-separated origins the browser may open, for example https://shop.example.com */
  allowedOrigins: z.string().max(2000).default(''),
  /** Name of a browser session a person captured once, including any MFA prompt. The platform never enters the second factor. */
  savedSessionName: z.string().max(120).optional(),
});

const TOOLS: Record<string, string> = {
  'browser.navigate': 'browser_navigate',
  'browser.snapshot': 'browser_snapshot',
  'browser.screenshot': 'browser_take_screenshot',
  'browser.network.observe': 'browser_network_requests',
  'browser.session.close': 'browser_close',
};

const INTERACT: Record<string, string> = { click: 'browser_click', type: 'browser_type', select: 'browser_select_option', press: 'browser_press_key' };

export const playwrightMcpProvider: ConnectorProvider = {
  manifest: {
    providerKey: PLAYWRIGHT_PROVIDER_KEY,
    category: 'browser-automation',
    displayName: 'Playwright (managed)',
    description: 'Drives a browser through the Playwright server this platform runs. For an application that asks for a second factor, capture a browser session once and name it here. The platform reuses that session and does not see the code.',
    authMethods: [],
    capabilities: ['browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.interact', 'browser.screenshot', 'browser.network.observe', 'browser.session.close'],
    requiredPermissions: ['None. The server runs inside the platform and reaches only the addresses you list.'],
    accessModePolicy: 'read_write',
    requiresInternet: false,
    verification: 'live-capable',
    wizard: [
      { key: 'connection', title: 'Browser server', fields: [{ name: 'baseUrl', label: 'Playwright server address (http://playwright-mcp:8931)', type: 'url', required: true }, { name: 'allowedOrigins', label: 'Application addresses the browser may open, separated by commas', type: 'text', required: true }, { name: 'savedSessionName', label: 'Saved browser session (optional, used for MFA)', type: 'text', required: false }] },
      { key: 'test', title: 'Test connection', action: 'test-connection' },
      { key: 'probe', title: 'Check what this server can do', action: 'probe-capabilities' },
      { key: 'review', title: 'Review', action: 'review' },
    ],
  },
  configSchema: ConfigSchema,
  secretSchema: z.object({}).strict(),
  create(config, _secrets, deps) {
    return new PlaywrightClient(ConfigSchema.parse(config), deps);
  },
};

class PlaywrightClient implements ConnectorClient {
  private rpc = 0;
  private tools = new Set<string>();

  constructor(
    private readonly cfg: z.infer<typeof ConfigSchema>,
    private readonly deps: AdapterDeps,
  ) {}

  private origins(): string[] {
    return this.cfg.allowedOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  }

  private async rpcCall(method: string, params?: unknown) {
    this.rpc += 1;
    const res = await requestJson(
      this.deps.http,
      { method: 'POST', url: joinUrl(this.cfg.baseUrl, '/mcp'), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.rpc, method, params }) },
      'Playwright',
    );
    if (res.body?.error) throw new PlatformError('transient', 'Playwright refused the request');
    return res.body?.result;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const result = await this.rpcCall('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa-platform', version: '0.0.0' } });
      return {
        ok: true,
        message: this.cfg.savedSessionName ? `Connected to the managed Playwright server. It will reuse the saved session "${this.cfg.savedSessionName}".` : 'Connected to the managed Playwright server.',
        latencyMs: Date.now() - started,
        discovered: { server: result?.serverInfo?.name, version: result?.serverInfo?.version, savedSession: this.cfg.savedSessionName, origins: this.origins() },
      };
    } catch (e) {
      return { ok: false, message: e instanceof PlatformError ? e.message : 'Could not reach the Playwright server', latencyMs: Date.now() - started };
    }
  }

  async inspectPermissions(): Promise<PermissionReport> {
    return { granted: ['browser'], writePermissionsDetected: [], notes: this.cfg.savedSessionName ? [`Saved session "${this.cfg.savedSessionName}" is reused. The platform does not enter MFA codes.`] : ['No saved session. The browser starts signed out.'] };
  }

  async probeCapabilities(): Promise<CapabilityProbeEntry[]> {
    let names: string[] = [];
    try {
      const listed = await this.rpcCall('tools/list');
      names = ((listed?.tools ?? []) as { name: string }[]).map((t) => t.name);
    } catch (e) {
      const reason = e instanceof PlatformError ? e.message : 'probe failed';
      return this.manifestCaps().map((capability) => ({ capability, support: capability === 'browser.session.open' ? 'supported' as const : 'unsupported' as const, reason }));
    }
    this.tools = new Set(names);
    return this.manifestCaps().map((capability) => {
      if (capability === 'browser.session.open') return { capability, support: 'supported' as const };
      if (capability === 'browser.interact') {
        const have = Object.values(INTERACT).filter((t) => names.includes(t));
        return { capability, support: have.length === Object.keys(INTERACT).length ? 'supported' as const : have.length > 0 ? 'partial' as const : 'unsupported' as const, reason: have.length === Object.keys(INTERACT).length ? undefined : 'Some browser actions are missing on this server' };
      }
      const tool = TOOLS[capability];
      return names.includes(tool!) ? { capability, support: 'supported' as const } : { capability, support: 'unsupported' as const, reason: `The server has no ${tool} tool` };
    });
  }

  private manifestCaps() {
    return playwrightMcpProvider.manifest.capabilities;
  }

  async handle(cap: CapabilityDescriptor, input: unknown): Promise<unknown> {
    const i = (input ?? {}) as Record<string, string>;
    if (cap.id === 'browser.session.open') return { sessionId: 'managed' };
    if (cap.id === 'browser.navigate') {
      const url = required(i.url, 'Address');
      const origin = new URL(url).origin;
      const allowed = this.origins();
      if (allowed.length === 0 || !allowed.includes(origin)) throw new PlatformError('denied', `The browser may not open ${origin}. Add it to the application addresses for this connector.`);
      await this.rpcCall('tools/call', { name: 'browser_navigate', arguments: { url, session: this.cfg.savedSessionName } });
      return { finalUrl: url };
    }
    if (cap.id === 'browser.snapshot') {
      const result = await this.rpcCall('tools/call', { name: 'browser_snapshot', arguments: {} });
      const text = ((result?.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n');
      return { accessibilityTree: text, url: String(result?.url ?? '') };
    }
    if (cap.id === 'browser.interact') {
      const tool = INTERACT[required(i.action, 'Browser action')];
      if (!tool) throw new PlatformError('validation', 'That browser action is not supported');
      await this.rpcCall('tools/call', { name: tool, arguments: { target: i.target, element: i.target, text: i.value, key: i.value, value: i.value } });
      return { ok: true };
    }
    if (cap.id === 'browser.screenshot') {
      const result = await this.rpcCall('tools/call', { name: 'browser_take_screenshot', arguments: { fullPage: true } });
      const image = ((result?.content ?? []) as { data?: string }[]).find((c) => c.data)?.data ?? '';
      return { artifactBase64: image };
    }
    if (cap.id === 'browser.network.observe') {
      const result = await this.rpcCall('tools/call', { name: 'browser_network_requests', arguments: {} });
      const requests = (result?.requests ?? []) as { url: string; status?: number }[];
      return { requests };
    }
    if (cap.id === 'browser.session.close') {
      await this.rpcCall('tools/call', { name: 'browser_close', arguments: {} });
      return { ok: true };
    }
    throw new PlatformError('unsupported', `Playwright does not implement ${cap.id}`);
  }

  async dispose() {}
}
