import { PlatformError, type Clock, type SecretLease, type SecretStore, systemClock } from '@qa/domain';
import type { CapabilityProbeEntry, CapabilityRegistry, ConnectorClient, ConnectorProvider, HttpPort, PermissionReport, ProviderRegistry } from '@qa/connector-sdk';
import { connectorSecretLocator, type AuditSink, type CapabilityStateRecord, type ConnectorRecord, type ConnectorRepository, type TestRequestQueue, type TestRequestRecord, type TestResult } from '@qa/application';
import { SecretRedactor } from '@qa/security';

export interface ConnectorTesterDeps {
  connectors: ConnectorRepository;
  tests: TestRequestQueue;
  /** The worker is the only side that may read connector secrets. */
  secrets: Pick<SecretStore, 'lease'>;
  providers: ProviderRegistry;
  capabilities: CapabilityRegistry;
  /** Built per test from the current approved-host list, so an approval takes effect without a restart. */
  http: () => Promise<HttpPort>;
  audit?: AuditSink;
  clock?: Clock;
  /** A test still running after this long is failed (its worker died). */
  staleAfterMs?: number;
  testTimeoutMs?: number;
}

const WRITE_PERMISSION_NOTE = 'The credential has write permissions. The platform only reads from this connector; use a read-only credential.';

/**
 * Executes queued Test Connection requests: connectivity, capability probing and permission inspection.
 * Results land in Postgres; the API only ever sees outcomes, never credentials.
 */
export class ConnectorTester {
  private readonly clock: Clock;

  constructor(private readonly d: ConnectorTesterDeps) {
    this.clock = d.clock ?? systemClock;
  }

  /** Returns 'busy' when it processed a request so the worker loop asks again at once. */
  async runOnce(): Promise<'busy' | 'idle'> {
    await this.d.tests.failStale(new Date(this.clock.now().getTime() - (this.d.staleAfterMs ?? 5 * 60_000)));
    const req = await this.d.tests.claimNext();
    if (!req) return 'idle';
    let result: TestResult;
    try {
      result = await this.execute(req);
    } catch (e) {
      result = { ok: false, message: e instanceof PlatformError ? e.message : 'The test could not be completed.', errorClass: e instanceof PlatformError ? e.errorClass : 'internal' };
    }
    await this.d.tests.finish(req.id, result.ok ? 'succeeded' : 'failed', result);
    await this.d.audit?.append({
      actorId: 'system:connector-tester',
      action: result.ok ? 'connector.test.succeeded' : 'connector.test.failed',
      subjectType: 'connector',
      subjectId: req.connectorId,
      detail: { requestId: req.id, requestedBy: req.requestedBy, errorClass: result.errorClass },
    });
    return 'busy';
  }

  private async execute(req: TestRequestRecord): Promise<TestResult> {
    const rec = await this.d.connectors.get(req.connectorId);
    if (!rec) return { ok: false, message: 'The connector no longer exists.', errorClass: 'not-found' };
    if (rec.status === 'disconnected') return { ok: false, message: 'The connector is disconnected.', errorClass: 'conflict' };
    if (rec.configVersion !== req.configVersion) return { ok: false, message: 'The settings changed after this test was requested. Run the test again.', errorClass: 'conflict' };

    const provider = this.d.providers.get(rec.providerKey);
    const redactor = new SecretRedactor();
    let lease: SecretLease | undefined;
    let client: ConnectorClient | undefined;
    try {
      if (provider.manifest.authMethods.length > 0) {
        try {
          lease = await this.d.secrets.lease(connectorSecretLocator(rec.id), { ttlMs: 2 * 60_000 });
        } catch {
          return await this.fail(rec, 'No credentials are stored for this connector.', 'auth');
        }
        redactor.register(lease.value);
      }
      client = provider.create(rec.config, lease, { http: await this.d.http() });
      return await this.withTimeout(this.probe(rec, provider, client, redactor));
    } catch (e) {
      const msg = e instanceof PlatformError ? e.message : 'The connector could not be tested.';
      return await this.fail(rec, redactor.redactString(msg), e instanceof PlatformError ? e.errorClass : 'internal');
    } finally {
      await client?.dispose().catch(() => undefined);
      lease?.release();
    }
  }

  private async probe(rec: ConnectorRecord, provider: ConnectorProvider, client: ConnectorClient, redactor: SecretRedactor): Promise<TestResult> {
    const conn = await client.testConnection();
    const message = redactor.redactString(conn.message);
    if (!conn.ok) return this.fail(rec, message, 'connection', conn.latencyMs);

    const [probes, permissions] = await Promise.all([client.probeCapabilities(), client.inspectPermissions()]);
    if (!(await this.stillCurrent(rec))) return { ok: false, message: 'The settings changed while the test was running. Run the test again.', errorClass: 'conflict' };

    const states = this.capabilityStates(rec, provider, probes);
    const writeDetected = permissions.writePermissionsDetected.length > 0;
    if (writeDetected && rec.category === 'source-repo') {
      return this.fail(rec, WRITE_PERMISSION_NOTE, 'policy', conn.latencyMs, { permissionReport: permissions, states });
    }
    const warnings = [...(writeDetected ? [WRITE_PERMISSION_NOTE] : []), ...(conn.discovered?.tokenExpiryWarning === true ? [message] : [])];
    const now = this.clock.now();
    await this.d.connectors.replaceCapabilityStates(rec.id, states);
    await this.d.connectors.update(rec.id, {
      status: warnings.length > 0 ? 'degraded' : 'connected',
      lastSuccessAt: now,
      lastTestedAt: now,
      permissionReport: redactor.redact({ ...permissions, notes: [...(permissions.notes ?? []), ...warnings.filter((w) => w !== message)] }) as PermissionReport,
      discoveredInfo: redactor.redact(conn.discovered ?? {}) as Record<string, unknown>,
    });
    await this.d.connectors.recordHealth(rec.id, { result: warnings.length > 0 ? 'warn' : 'ok', latencyMs: conn.latencyMs, detail: { capabilitiesGranted: states.filter((s) => s.granted).length } });
    return { ok: true, message: warnings.length > 0 ? `${message} ${warnings.join(' ')}`.trim() : message, latencyMs: conn.latencyMs };
  }

  private capabilityStates(rec: ConnectorRecord, provider: ConnectorProvider, probes: CapabilityProbeEntry[]): CapabilityStateRecord[] {
    const byId = new Map(probes.map((p) => [p.capability, p]));
    return [...provider.manifest.capabilities].sort().map((capability) => {
      const probe = byId.get(capability);
      const support = probe?.support ?? 'unsupported';
      const isWrite = this.d.capabilities.has(capability) && this.d.capabilities.get(capability).access === 'write';
      const blockedByMode = isWrite && rec.accessMode === 'read_only';
      return {
        capability,
        support,
        reason: probe?.reason ?? (probe ? undefined : 'The connector did not report this capability'),
        granted: support !== 'unsupported' && !blockedByMode,
      };
    });
  }

  private async fail(rec: ConnectorRecord, message: string, errorClass: string, latencyMs?: number, extra?: { permissionReport: PermissionReport; states: CapabilityStateRecord[] }): Promise<TestResult> {
    if (await this.stillCurrent(rec)) {
      if (extra) await this.d.connectors.replaceCapabilityStates(rec.id, extra.states.map((s) => ({ ...s, granted: false })));
      await this.d.connectors.update(rec.id, { status: 'error', enabled: false, lastTestedAt: this.clock.now(), ...(extra ? { permissionReport: extra.permissionReport } : {}) });
      await this.d.connectors.recordHealth(rec.id, { result: 'fail', latencyMs, detail: { errorClass } });
    }
    return { ok: false, message, latencyMs, errorClass };
  }

  private async stillCurrent(rec: ConnectorRecord): Promise<boolean> {
    const now = await this.d.connectors.get(rec.id);
    return !!now && now.configVersion === rec.configVersion && now.status !== 'disconnected';
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const ms = this.d.testTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError('transient', 'The connector did not answer in time.')), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}
