import { z } from 'zod';
import { PlatformError, urlAllowedByAllowlist } from '@qa/domain';
import type { AdapterDeps, CapabilityDescriptor, CapabilityProbeEntry, ConnectionTestResult, ConnectorClient, ConnectorProvider, PermissionReport } from '@qa/connector-sdk';
import { joinUrl, requestJson, required } from '../rest';

export const PLAYWRIGHT_PROVIDER_KEY = 'playwright-mcp';

/**
 * Build/ops marker — Explore UI session continuity (QA-42 pool + QA-43 close/recovery).
 * Verify the running worker image includes this string (see qa-43 notes).
 */
export const PLAYWRIGHT_MCP_SESSION_MODE = 'durable-pool-qa43';

/**
 * ConnectorExecutionManager creates a new PlaywrightClient per invoke() and disposes it.
 * Without an in-process pool, navigate and evaluate can land on different clients/sessions
 * ("No open pages available") even when the platform sessionId is passed correctly.
 */
const liveBySessionId = new Map<string, PlaywrightClient>();

const browserProfileBusy = (msg: string) =>
  /Browser is already in use|already in use for .+mcp-chromium|use --isolated/i.test(msg);

/** Test-only: clear durable session owners between cases. */
export function resetPlaywrightMcpSessionPoolForTests(): void {
  liveBySessionId.clear();
}

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
  'browser.wait': 'browser_wait_for',
  'browser.evaluate': 'browser_evaluate',
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
    capabilities: ['browser.session.open', 'browser.navigate', 'browser.snapshot', 'browser.wait', 'browser.evaluate', 'browser.interact', 'browser.screenshot', 'browser.network.observe', 'browser.session.close'],
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
      const msg = JSON.parse(payload) as { result?: unknown; error?: unknown; method?: string };
      // Ignore progress/notification events; keep the last JSON-RPC response.
      if (msg && typeof msg === 'object' && ('result' in msg || 'error' in msg)) found = msg;
    } catch { /* a non-JSON event is ignored */ }
  }
  return found;
}

/** Flatten MCP tools/call `content[]` text parts (and surface tool errors). */
function toolText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as { isError?: boolean; content?: { type?: string; text?: string }[] };
  const text = (r.content ?? [])
    .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
  if (r.isError) {
    throw new PlatformError('transient', text || 'Playwright tool returned an error');
  }
  return text;
}

/** Pull Page URL / Title from Playwright MCP page-state markdown. */
function pageMetaFromToolText(text: string): { url: string; title: string; accessibilityTree: string } {
  const url = /(?:^|\n)-\s*Page URL:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
  const title = /(?:^|\n)-\s*Page Title:\s*(.*)/i.exec(text)?.[1]?.trim() ?? '';
  return { url, title, accessibilityTree: text };
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

  /**
   * The execution manager creates a **new** client per invoke(). Without adopting the
   * platform `sessionId` into the MCP `mcp-session-id` header, navigate and evaluate
   * each call `initialize` and get a blank browser ("No open pages available").
   */
  private adoptPlatformSession(sessionId: string): void {
    const id = required(sessionId, 'sessionId').trim();
    if (!id || id === 'managed') {
      throw new PlatformError(
        'validation',
        'Playwright browser call needs the real mcp-session-id from browser.session.open (not "managed"). Re-run Explore UI after fixing the Playwright connector.',
      );
    }
    if (this.sessionId === id && this.opening) return;
    this.sessionId = id;
    // Skip initialize — the MCP session (and its open tab) already exists on the server.
    this.opening = Promise.resolve({ adopted: true });
    // Avoid JSON-RPC id collisions with the client that opened the session.
    this.rpc = (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1_000);
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
      // Streamable HTTP returns 404 when mcp-session-id is unknown (session closed / wrong id / worker stale).
      if (e instanceof PlatformError && (e.errorClass === 'not-found' || /status 404/i.test(e.message))) {
        throw new PlatformError(
          'transient',
          `Playwright MCP session was not found (mcp-session-id=${this.sessionId ?? 'none'}). ` +
            'The browser tab from navigate is gone — rebuild/restart the worker so it runs durable-pool-qa42, ' +
            'rebuild playwright-mcp if the image is stale, Test connection, then retry Explore UI.',
          e.details,
          e,
        );
      }
      throw e;
    }
    const session = res.headers['mcp-session-id']?.trim();
    // Never rotate away from the Explore session mid-flight (would open a blank browser).
    if (session && !this.sessionId) this.sessionId = session;
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

  /** Rewrite Chromium navigate failures so Explore shows HTTP status / shop-IP guidance. */
  private navigateFailure(url: string, e: unknown): PlatformError {
    const msg = e instanceof PlatformError ? e.message : String(e);
    if (browserProfileBusy(msg)) {
      return new PlatformError(
        'transient',
        'Playwright Chromium profile is still locked after close/retry. Rebuild playwright-mcp with --isolated and recreate the container, then retry Explore UI.',
        undefined,
        e,
      );
    }
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(msg)) {
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch { /* keep */ }
      return new PlatformError(
        'transient',
        `Chromium reached ${url} but HTTP failed (ERR_HTTP_RESPONSE_CODE_FAILURE — typically 4xx/5xx). ` +
          `DNS worked; ${host} is likely mapped to the wrong IP (host-gateway / Docker host instead of the shop VirtualHost). ` +
          `Set PLAYWRIGHT_MCP_SHOP_IP to the real LAN IP, apply deploy/compose/local/docker-compose.playwright-shop.yml, ` +
          `recreate playwright-mcp, confirm verify-playwright-shop-dns.sh shows HTTP 2xx, then retry.`,
        undefined,
        e,
      );
    }
    if (/ERR_NAME_NOT_RESOLVED|DNS_PROBE_FINISHED_NXDOMAIN/i.test(msg)) {
      return new PlatformError(
        'transient',
        `Chromium could not resolve ${url}. Set PLAYWRIGHT_MCP_SHOP_IP and apply the playwright-shop compose overlay, then recreate playwright-mcp.`,
        undefined,
        e,
      );
    }
    return e instanceof PlatformError ? e : new PlatformError('transient', msg, undefined, e);
  }

  /**
   * Best-effort browser_close on pooled owners so a stuck mcp-chromium profile can unlock.
   * Keeps `keep` registered (MCP session + durable pool) so navigate can retry on the same session.
   */
  private async releasePooledBrowsers(keep?: PlaywrightClient): Promise<void> {
    const owners = [...new Set(liveBySessionId.values())];
    for (const owner of owners) {
      try {
        await owner.rpcCall('tools/call', { name: 'browser_close', arguments: {} });
      } catch {
        /* already closed / session gone */
      }
      if (owner === keep) continue;
      const id = owner.sessionId;
      if (id) liveBySessionId.delete(id);
      owner.sessionId = undefined;
      owner.opening = undefined;
    }
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
    if (browserProfileBusy(msg)) {
      return (
        'Playwright Chromium profile is locked (Browser already in use for mcp-chromium). ' +
        'Rebuild playwright-mcp with --isolated (QA-43), recreate the browser container, then retry. ' +
        'If the image already has --isolated, restart playwright-mcp to clear a stuck session.'
      );
    }
    if (/No usable sandbox|chromiumSandbox|Invalid URL:\s*undefined|--no-sandbox/i.test(msg)) {
      return (
        'Playwright Chromium aborted in the container (sandbox / CDP URL undefined). ' +
        'Rebuild playwright-mcp with --no-sandbox and PLAYWRIGHT_MCP_SANDBOX=0 (QA-44), then recreate the browser service.'
      );
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
      const id = this.sessionId?.trim();
      if (!id) {
        throw new PlatformError(
          'transient',
          'Playwright MCP did not return mcp-session-id on initialize. Explore UI cannot keep navigate and evaluate on the same browser tab.',
        );
      }
      // Manager will dispose this wrapper after open — keep the same instance for navigate/evaluate.
      liveBySessionId.set(id, this);
      // Structured log so operators can confirm the rebuilt worker (durable-pool-qa42) is live.
      console.info(JSON.stringify({
        msg: 'playwright mcp session open',
        sessionMode: PLAYWRIGHT_MCP_SESSION_MODE,
        mcpSessionIdPrefix: id.slice(0, 8),
      }));
      return { sessionId: id, sessionMode: PLAYWRIGHT_MCP_SESSION_MODE };
    }
    const platformSession = required(i.sessionId, 'sessionId').trim();
    const owner = liveBySessionId.get(platformSession);
    // Durable path: run on the exact client that opened (and navigated) this MCP session.
    if (owner && owner !== this) {
      return owner.handle(cap, input);
    }
    // Fallback when the open client is gone (worker restart mid-run): reattach via mcp-session-id header.
    this.adoptPlatformSession(platformSession);
    if (!owner) liveBySessionId.set(platformSession, this);
    if (cap.id === 'browser.navigate') {
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
      // Do not pass unknown args (e.g. savedSessionName as `session`) — 0.0.35 navigate only accepts `url`.
      const navArgs: Record<string, unknown> = { url };
      const runNavigate = async () => {
        const navResult = await this.rpcCall('tools/call', { name: 'browser_navigate', arguments: navArgs });
        let text = toolText(navResult);
        // Give SPAs a settle window; browser_wait_for also re-attaches a snapshot.
        try {
          const waited = await this.rpcCall('tools/call', { name: 'browser_wait_for', arguments: { time: 2.5 } });
          const waitedText = toolText(waited);
          if (waitedText.length >= text.length) text = waitedText;
        } catch {
          /* wait_for is best-effort; navigate snapshot may already be enough */
        }
        return text;
      };
      let text: string;
      try {
        text = await runNavigate();
      } catch (e) {
        const msg = e instanceof PlatformError ? e.message : String(e);
        if (browserProfileBusy(msg)) {
          // Prior Explore/Test left a locked persistent profile — close pooled browsers and retry once.
          console.warn(JSON.stringify({ msg: 'playwright browser profile busy; releasing pooled sessions and retrying navigate' }));
          await this.releasePooledBrowsers(this);
          if (this.sessionId) liveBySessionId.set(this.sessionId, this);
          try {
            text = await runNavigate();
          } catch (e2) {
            throw this.navigateFailure(url, e2);
          }
        } else {
          throw this.navigateFailure(url, e);
        }
      }
      // MCP sometimes returns page state after a soft HTTP failure without throwing.
      if (/ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(text)) {
        throw this.navigateFailure(url, new PlatformError('transient', text));
      }
      const meta = pageMetaFromToolText(text);
      return {
        finalUrl: meta.url || url,
        accessibilityTree: meta.accessibilityTree || undefined,
        title: meta.title || undefined,
      };
    }
    if (cap.id === 'browser.snapshot') {
      const result = await this.rpcCall('tools/call', { name: 'browser_snapshot', arguments: {} });
      const text = toolText(result);
      // Return empty tree instead of throwing — Explore UI retries + DOM probe handle blank
      // pages; throwing transient here opened the connector circuit breaker after a few attempts.
      if (!text) {
        return { accessibilityTree: '', url: '', title: undefined };
      }
      if (/No open pages?/i.test(text) || /No open tabs/i.test(text)) {
        throw new PlatformError(
          'transient',
          'Playwright has no open page for browser.snapshot — navigate did not leave a tab on this MCP session. Retry Explore UI; if it persists, Test connection and confirm mcp-session-id is returned.',
        );
      }
      const meta = pageMetaFromToolText(text);
      return {
        accessibilityTree: meta.accessibilityTree,
        url: meta.url || String((result as { url?: string })?.url ?? ''),
        title: meta.title || undefined,
      };
    }
    if (cap.id === 'browser.wait') {
      const timeRaw = (input as { timeSeconds?: number })?.timeSeconds;
      const text = typeof i.text === 'string' && i.text.trim() ? i.text.trim() : undefined;
      const time = typeof timeRaw === 'number' && Number.isFinite(timeRaw) ? Math.min(30, Math.max(0.1, timeRaw)) : undefined;
      if (!text && time === undefined) {
        throw new PlatformError('validation', 'browser.wait needs timeSeconds and/or text');
      }
      const args: Record<string, unknown> = {};
      if (text) args.text = text;
      if (time !== undefined) args.time = time;
      const result = await this.rpcCall('tools/call', { name: 'browser_wait_for', arguments: args });
      const body = toolText(result);
      const meta = pageMetaFromToolText(body);
      return {
        ok: true,
        accessibilityTree: meta.accessibilityTree || undefined,
        url: meta.url || undefined,
        title: meta.title || undefined,
      };
    }
    if (cap.id === 'browser.evaluate') {
      const script = required(i.script, 'script');
      const noPage = (msg: string) => new PlatformError(
        'transient',
        'Playwright browser_evaluate has no open page (MCP session lost the tab after navigate). Explore UI must keep one mcp-session-id for open → navigate → evaluate.',
        undefined,
        msg ? new Error(msg) : undefined,
      );
      let body: string;
      try {
        const result = await this.rpcCall('tools/call', { name: 'browser_evaluate', arguments: { function: script } });
        body = toolText(result);
      } catch (e) {
        const msg = e instanceof PlatformError ? e.message : String(e);
        if (/No open pages?/i.test(msg) || /No open tabs/i.test(msg)) throw noPage(msg);
        throw e;
      }
      if (!body) {
        throw new PlatformError('transient', 'Playwright browser_evaluate returned no content');
      }
      if (/No open pages?/i.test(body) || /No open tabs/i.test(body)) throw noPage(body);
      const meta = pageMetaFromToolText(body);
      // Prefer the ### Result JSON block; fall back to the full tool text.
      const resultMatch = /###\s*Result\s*\r?\n([\s\S]*?)(?=\r?\n###\s+|$)/i.exec(body);
      const resultText = (resultMatch?.[1] ?? body).trim();
      return {
        resultText,
        accessibilityTree: meta.accessibilityTree || undefined,
        url: meta.url || undefined,
        title: meta.title || undefined,
      };
    }
    if (cap.id === 'browser.interact') {
      const tool = INTERACT[required(i.action, 'Browser action')];
      if (!tool) throw new PlatformError('validation', 'That browser action is not supported');
      await this.rpcCall('tools/call', { name: tool, arguments: { target: i.target, element: i.target, text: i.value, key: i.value, value: i.value } });
      return { ok: true };
    }
    if (cap.id === 'browser.screenshot') {
      // @playwright/mcp@0.0.35 omits image bytes when fullPage=true (saves to disk only).
      // Request a viewport screenshot so Explore UI can attach evidence.
      const result = await this.rpcCall('tools/call', { name: 'browser_take_screenshot', arguments: { type: 'png' } });
      const image = ((result?.content ?? []) as { type?: string; data?: string }[])
        .find((c) => c.data && (c.type === 'image' || !c.type))?.data ?? '';
      return { artifactBase64: image };
    }
    if (cap.id === 'browser.network.observe') {
      const result = await this.rpcCall('tools/call', { name: 'browser_network_requests', arguments: {} });
      const requests = (result?.requests ?? []) as { url: string; status?: number }[];
      return { requests };
    }
    if (cap.id === 'browser.session.close') {
      const id = this.sessionId;
      // Drop the pool entry first so a parallel open cannot reuse a closing owner.
      if (id) liveBySessionId.delete(id);
      try {
        await this.rpcCall('tools/call', { name: 'browser_close', arguments: {} });
      } catch {
        /* session may already be gone */
      }
      this.sessionId = undefined;
      this.opening = undefined;
      return { ok: true };
    }
    throw new PlatformError('unsupported', `Playwright does not implement ${cap.id}`);
  }

  /** Manager always dispose()s after invoke — must not drop the durable Explore session. */
  async dispose() {}
}
