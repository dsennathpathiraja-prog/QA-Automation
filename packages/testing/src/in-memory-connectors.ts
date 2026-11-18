import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type {
  ApprovedHost,
  ApprovedHostRepository,
  AuditSink,
  CapabilityStateRecord,
  ConnectorPatch,
  ConnectorRecord,
  ConnectorRepository,
  NewConnector,
  OperationLogReader,
  OperationLogRow,
  TestRequestQueue,
  TestRequestRecord,
  TestResult,
} from '@qa/application';

export class InMemoryConnectorRepository implements ConnectorRepository {
  readonly rows = new Map<string, ConnectorRecord>();
  readonly states = new Map<string, CapabilityStateRecord[]>();
  readonly health: { id: string; result: string; detail?: Record<string, unknown>; latencyMs?: number }[] = [];
  private readonly deleted = new Set<string>();

  async list() {
    return [...this.rows.values()].filter((r) => !this.deleted.has(r.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async get(id: string) {
    return this.deleted.has(id) ? undefined : this.rows.get(id);
  }

  async insert(n: NewConnector) {
    if ([...this.rows.values()].some((r) => !this.deleted.has(r.id) && r.providerKey === n.providerKey && r.name === n.name)) {
      throw new PlatformError('conflict', `A connector named "${n.name}" already exists for this provider.`);
    }
    const now = new Date();
    const rec: ConnectorRecord = { ...n, status: 'draft', enabled: false, configVersion: 1, createdAt: now, updatedAt: now };
    this.rows.set(n.id, rec);
    return structuredClone(rec);
  }

  async update(id: string, patch: ConnectorPatch) {
    const rec = this.rows.get(id);
    if (!rec || this.deleted.has(id)) throw new PlatformError('not-found', 'Connector not found');
    if (patch.name && patch.name !== rec.name && [...this.rows.values()].some((r) => r.id !== id && !this.deleted.has(r.id) && r.providerKey === rec.providerKey && r.name === patch.name)) {
      throw new PlatformError('conflict', `A connector named "${patch.name}" already exists for this provider.`);
    }
    const { permissionReport, discoveredInfo, ...rest } = patch;
    Object.assign(rec, rest, { updatedAt: new Date() });
    if (permissionReport !== undefined) rec.permissionReport = permissionReport ?? undefined;
    if (discoveredInfo !== undefined) rec.discoveredInfo = discoveredInfo ?? undefined;
    return structuredClone(rec);
  }

  async softDelete(id: string) {
    this.deleted.add(id);
  }

  async capabilityStates(id: string) {
    return structuredClone(this.states.get(id) ?? []);
  }

  async replaceCapabilityStates(id: string, s: CapabilityStateRecord[]) {
    this.states.set(id, structuredClone(s));
  }

  async recordHealth(id: string, h: { result: 'ok' | 'warn' | 'fail'; detail?: Record<string, unknown>; latencyMs?: number }) {
    this.health.push({ id, ...h });
  }
}

export class InMemoryTestQueue implements TestRequestQueue {
  readonly rows: TestRequestRecord[] = [];

  async enqueue(connectorId: string, configVersion: number, requestedBy: string) {
    const open = this.rows.find((r) => r.connectorId === connectorId && (r.status === 'pending' || r.status === 'running'));
    if (open) return structuredClone(open);
    const rec: TestRequestRecord = { id: randomUUID(), connectorId, configVersion, status: 'pending', requestedBy, requestedAt: new Date() };
    this.rows.push(rec);
    return structuredClone(rec);
  }

  async latest(connectorId: string) {
    const last = this.rows.filter((x) => x.connectorId === connectorId).at(-1);
    return last && structuredClone(last);
  }

  async claimNext() {
    const next = this.rows.find((r) => r.status === 'pending');
    if (!next) return undefined;
    next.status = 'running';
    next.startedAt = new Date();
    return structuredClone(next);
  }

  async finish(id: string, status: 'succeeded' | 'failed', result: TestResult) {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new PlatformError('not-found', 'test request not found');
    Object.assign(r, { status, result, finishedAt: new Date() });
  }

  async failStale(before: Date) {
    let n = 0;
    for (const r of this.rows) {
      if (r.status === 'running' && r.startedAt && r.startedAt < before) {
        Object.assign(r, { status: 'failed', finishedAt: new Date(), result: { ok: false, message: 'The test did not finish. Try again.', errorClass: 'transient' } });
        n += 1;
      }
    }
    return n;
  }
}

export class InMemoryHostRepository implements ApprovedHostRepository {
  readonly rows: ApprovedHost[] = [];

  async list(purpose?: ApprovedHost['purpose']) {
    return structuredClone(this.rows.filter((r) => !purpose || r.purpose === purpose));
  }

  async add(h: Parameters<ApprovedHostRepository['add']>[0]) {
    if (this.rows.some((r) => r.hostPattern.toLowerCase() === h.hostPattern.toLowerCase() && r.purpose === h.purpose)) throw new PlatformError('conflict', 'This host is already approved.');
    const rec: ApprovedHost = { id: randomUUID(), hostPattern: h.hostPattern, purpose: h.purpose, internal: h.internal, allowHttp: h.allowHttp, approvedAt: new Date() };
    this.rows.push(rec);
    return structuredClone(rec);
  }

  async remove(id: string) {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return undefined;
    return this.rows.splice(i, 1)[0];
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly entries: { actorId: string; action: string; subjectType: string; subjectId?: string; detail?: Record<string, unknown> }[] = [];
  async append(e: (typeof this.entries)[number]) {
    this.entries.push(structuredClone(e));
  }
}

export class InMemoryOperationLogReader implements OperationLogReader {
  constructor(readonly rows: OperationLogRow[] = []) {}
  async list(f: Parameters<OperationLogReader['list']>[0]) {
    return this.rows
      .filter((r) => (!f.connectorInstanceId || r.connectorInstanceId === f.connectorInstanceId) && (!f.outcome || r.outcome === f.outcome) && (!f.capability || r.capability === f.capability) && (!f.beforeSeq || r.seq < f.beforeSeq))
      .sort((a, b) => b.seq - a.seq)
      .slice(0, f.limit);
  }
}
