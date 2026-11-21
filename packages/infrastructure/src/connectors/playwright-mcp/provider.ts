import { z } from 'zod';
import { PlatformError, urlAllowedByAllowlist } from '@qa/domain';
import type { AdapterDeps, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { joinUrl, requestJson, required } from '../rest';

export const PLAYWRIGHT_PROVIDER_KEY = 'playwright-mcp';

const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  /** Comma-separated origins or host patterns the browser may open, for example https://shop.example.com or shop.example.com */
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
      { key: 'connection', title: 'Browser server', fields: [{ name: 'baseUrl', label: 'Playwright server address (from the worker: http://playwright-mcp:8931 / PLAYWRIGHT_MCP_URL — not localhost; start Compose profile browser on the worker network first)', type: 'url', required: true }, { name: 'allowedOrigins', label: 'Application addresses or host names the browser may open, separated by commas', type: 'text', required: true }, { name: 'savedSessionName', label: 'Saved browser session (optional, used for MFA)', type: 'text', required: false }] },
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

/** Playwright answers with one JSON object or with an event-stream line beginning `data:`. */
function rpcMessage(body: unknown, text: string): { result?: any; error?: unknown } | undefined {
  if (body && typeof body === 'object' && ('result' in body || 'error' in body)) return body as { result?: any; error?: unknown };
  let found: { result?: any; error?: unknown } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const msg = JSON.parse(payload) as { result?: unknown; error?: unknown };
      if (msg && typeof msg === 'object') found = msg;
    } catch { /* a non-JSON event is ignored */ }
  }
  return found;
}

class PlaywrightClient implements ConnectorClient {
  private rpc = 0;
  private tools = new Set<string>();
  private sessionId?: string;
  private opening?: Promise<any>;

  constructor(
    private readonly cfg: z.infer<typeof ConfigSchema>,
    private readonly deps: AdapterDeps,
  ) {}

  private origins(): string[] {
    return this.cfg.allowedOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    return headers;
  }

  private async post(payload: unknown) {
    let res;
    try {
      res = await requestJson(this.deps.http, { method: 'POST', url: joinUrl(this.cfg.baseUrl, '/mcp'), headers: this.headers(), body: JSON.stringify(payload) }, 'Playwright');
    } catch (e) {
      // Explore UI and other live calls must get the same reachability guidance as Test connection.
      if (
        e instanceof PlatformError &&
        /could not resolve|connection refused|ECONNREFUSED|network error|Could not reach|timed out|aborted|protocol .* not allowed|ERR_SSL/i.test(e.message)
      ) {
        throw new PlatformError(e.errorClass, this.connectionFailureMessage(e), e.details, e);
      }
      throw e;
    }
    const session = res.headers['mcp-session-id'];
    if (session) this.sessionId = session;
    return rpcMessage(res.body, res.text);
  }

  /** Open one browser-server session. The server rejects a call that does not accept its event stream. */
  private open() {
    this.opening ??= this.startSession();
    return this.opening;
  }

  private async startSession() {
    this.rpc += 1;
    const message = await this.post({ jsonrpc: '2.0', id: this.rpc, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'qa-platform', version: '0.0.0' } } });
    if (message?.error) throw new PlatformError('transient', 'Playwright refused the request');
    try {
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch { /* The server already accepted initialize. */ }
    return message?.result;
  }

  private async rpcCall(method: string, params?: unknown) {
    await this.open();
    this.rpc += 1;
    const message = await this.post({ jsonrpc: '2.0', id: this.rpc, method, params });
    if (message?.error) throw new PlatformError('transient', 'Playwright refused the request');
    return message?.result;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const result = await this.open();
      return {
        ok: true,
        message: this.cfg.savedSessionName ? `Connected to the managed Playwright server. It will reuse the saved session "${this.cfg.savedSessionName}".` : 'Connected to the managed Playwright server.',
        latencyMs: Date.now() - started,
        discovered: { server: result?.serverInfo?.name, version: result?.serverInfo?.version, savedSession: this.cfg.savedSessionName, origins: this.origins() },
      };
    } catch (e) {
      return { ok: false, message: this.connectionFailureMessage(e), latencyMs: Date.now() - started };
    }
  }

  /** Turn reachability / policy failures into an actionable message for Test Connection / Explore UI. */
  private connectionFailureMessage(e: unknown): string {
    const msg = e instanceof PlatformError ? e.message : 'Could not reach Playwright';
    // Already rewritten (Explore UI path wraps before Test connection).
    if (/^Could not reach Playwright at |^DNS could not resolve Playwright|^Playwright refused the TCP connection|^Timed out reaching Playwright|^Wrong URL scheme for Playwright/i.test(msg)) {
      return msg;
    }
    const workerUrlHint =
      'From the worker use http://playwright-mcp:8931 (Compose DNS / PLAYWRIGHT_MCP_URL — not localhost, not qa-playwright-mcp). ' +
      'Rebuild Compose profile "browser" if docker logs show "unknown option", then approve host playwright-mcp for plain http if asked.';
    if (/could not resolve/i.test(msg)) {
      return (
        `DNS could not resolve Playwright host for ${this.cfg.baseUrl}. ` +
        'The playwright-mcp container is missing from the worker’s Compose network (wrong project, profile not started, or crash loop). ' +
        workerUrlHint
      );
    }
    if (/connection refused|ECONNREFUSED/i.test(msg)) {
      return (
        `Playwright refused the TCP connection at ${this.cfg.baseUrl} (nothing listening on :8931). ` +
        'Check `docker compose … logs playwright-mcp` — pinned @playwright/mcp@0.0.35 must not receive unsupported flags such as --allowed-hosts. ' +
        workerUrlHint
      );
    }
    if (/timed out|aborted/i.test(msg)) {
      return (
        `Timed out reaching Playwright at ${this.cfg.baseUrl}. ` +
        'Confirm the browser service is healthy (`docker compose … ps`) on the same network as the worker. ' +
        workerUrlHint
      );
    }
    if (/wrong protocol|ERR_SSL|SSL|https?.*mismatch|protocol .* not allowed/i.test(msg)) {
      return (
        `Wrong URL scheme for Playwright at ${this.cfg.baseUrl}. Use plain http://playwright-mcp:8931 from the worker (not https).`
      );
    }
    if (/network error|Could not reach/i.test(msg)) {
      return `Could not reach Playwright at ${this.cfg.baseUrl}. ${workerUrlHint}`;
    }
    if (e instanceof PlatformError && e.errorClass === 'denied') {
      if (/approved-host|plain http|loopback|HTTP method/i.test(msg)) return msg;
      return 'The Playwright server refused this call (HTTP 403). Confirm the connector uses http://playwright-mcp:8931 and host playwright-mcp is approved for plain http.';
    }
    return msg;
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
    if (cap.id === 'browser.session.open') {
      // Establish the MCP session (initialize + session header) before navigate.
      await this.open();
      const id = this.sessionId?.trim() || 'managed';
      this.sessionId = id;
      return { sessionId: id };
    }
    if (cap.id === 'browser.navigate') {
      required(i.sessionId, 'sessionId');
      const url = required(i.url, 'Address');
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        throw new PlatformError('validation', 'invalid URL');
      }
      const allowed = this.origins();
      if (allowed.length === 0 || !urlAllowedByAllowlist(url, allowed)) {
        throw new PlatformError('denied', `The browser may not open ${origin}. Add it to the application addresses for this connector.`);
      }
      await this.rpcCall('tools/call', { name: 'browser_navigate', arguments: { url, session: this.cfg.savedSessionName } });
      return { finalUrl: url };
    }
    if (cap.id === 'browser.snapshot') {
      required(i.sessionId, 'sessionId');
      const result = await this.rpcCall('tools/call', { name: 'browser_snapshot', arguments: {} });
      const text = ((result?.content ?? []) as { text?: string }[]).map((c) => c.text ?? '').join('\n');
      return { accessibilityTree: text, url: String(result?.url ?? '') };
    }
    if (cap.id === 'browser.interact') {
      required(i.sessionId, 'sessionId');
      const tool = INTERACT[required(i.action, 'Browser action')];
      if (!tool) throw new PlatformError('validation', 'That browser action is not supported');
      await this.rpcCall('tools/call', { name: tool, arguments: { target: i.target, element: i.target, text: i.value, key: i.value, value: i.value } });
      return { ok: true };
    }
    if (cap.id === 'browser.screenshot') {
      required(i.sessionId, 'sessionId');
      const result = await this.rpcCall('tools/call', { name: 'browser_take_screenshot', arguments: { fullPage: true } });
      const image = ((result?.content ?? []) as { data?: string }[]).find((c) => c.data)?.data ?? '';
      return { artifactBase64: image };
    }
    if (cap.id === 'browser.network.observe') {
      required(i.sessionId, 'sessionId');
      const result = await this.rpcCall('tools/call', { name: 'browser_network_requests', arguments: {} });
      const requests = (result?.requests ?? []) as { url: string; status?: number }[];
      return { requests };
    }
    if (cap.id === 'browser.session.close') {
      required(i.sessionId, 'sessionId');
      await this.rpcCall('tools/call', { name: 'browser_close', arguments: {} });
      this.sessionId = undefined;
      this.opening = undefined;
      return { ok: true };
    }
    throw new PlatformError('unsupported', `Playwright does not implement ${cap.id}`);
  }

  async dispose() {}
}
