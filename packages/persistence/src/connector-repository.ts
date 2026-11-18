import { and, eq, isNull, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { CapabilityStateRecord, ConnectorPatch, ConnectorRecord, ConnectorRepository, NewConnector } from '@qa/application';
import type { CapabilityId, ConnectorCategory, PermissionReport, SupportLevel } from '@qa/connector-sdk';
import type { Db } from './db';
import { connectorCapabilityState, connectorHealthCheck, connectorInstance } from './schema';

type Row = typeof connectorInstance.$inferSelect;

const toRecord = (r: Row): ConnectorRecord => ({
  id: r.id,
  providerKey: r.providerKey,
  category: r.category as ConnectorCategory,
  name: r.name,
  status: r.status as ConnectorRecord['status'],
  enabled: r.enabled,
  accessMode: r.accessMode as ConnectorRecord['accessMode'],
  config: r.config,
  permissionReport: (r.permissionReport ?? undefined) as PermissionReport | undefined,
  discoveredInfo: r.discoveredInfo ?? undefined,
  configVersion: r.configVersion,
  lastSuccessAt: r.lastSuccessAt ?? undefined,
  lastTestedAt: r.lastTestedAt ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
};

const live = (id: string) => and(eq(connectorInstance.id, id), isNull(connectorInstance.deletedAt));

export class PgConnectorRepository implements ConnectorRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<ConnectorRecord[]> {
    const rows = await this.db.select().from(connectorInstance).where(isNull(connectorInstance.deletedAt)).orderBy(connectorInstance.createdAt, connectorInstance.name);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<ConnectorRecord | undefined> {
    const [row] = await this.db.select().from(connectorInstance).where(live(id)).limit(1);
    return row && toRecord(row);
  }

  async insert(n: NewConnector): Promise<ConnectorRecord> {
    try {
      const [row] = await this.db
        .insert(connectorInstance)
        .values({ id: n.id, providerKey: n.providerKey, category: n.category, name: n.name, config: n.config, accessMode: n.accessMode })
        .returning();
      return toRecord(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A connector named "${n.name}" already exists for this provider.`);
      throw e;
    }
  }

  async update(id: string, patch: ConnectorPatch): Promise<ConnectorRecord> {
    const set: Partial<typeof connectorInstance.$inferInsert> = { updatedAt: new Date(), rowVersion: sql`${connectorInstance.rowVersion} + 1` as unknown as number };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.config !== undefined) set.config = patch.config;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.configVersion !== undefined) set.configVersion = patch.configVersion;
    if (patch.permissionReport !== undefined) set.permissionReport = (patch.permissionReport as unknown as Record<string, unknown> | null) ?? null;
    if (patch.discoveredInfo !== undefined) set.discoveredInfo = patch.discoveredInfo ?? null;
    if (patch.lastSuccessAt !== undefined) set.lastSuccessAt = patch.lastSuccessAt;
    if (patch.lastTestedAt !== undefined) set.lastTestedAt = patch.lastTestedAt;
    try {
      const [row] = await this.db.update(connectorInstance).set(set).where(live(id)).returning();
      if (!row) throw new PlatformError('not-found', 'Connector not found');
      return toRecord(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A connector named "${patch.name}" already exists for this provider.`);
      throw e;
    }
  }

  async softDelete(id: string): Promise<void> {
    await this.db.update(connectorInstance).set({ deletedAt: new Date(), enabled: false, updatedAt: new Date() }).where(live(id));
  }

  async capabilityStates(id: string): Promise<CapabilityStateRecord[]> {
    const rows = await this.db.select().from(connectorCapabilityState).where(eq(connectorCapabilityState.connectorInstanceId, id)).orderBy(connectorCapabilityState.capabilityId);
    return rows.map((r) => ({ capability: r.capabilityId as CapabilityId, support: r.support as SupportLevel, reason: r.reason ?? undefined, granted: r.granted }));
  }

  async replaceCapabilityStates(id: string, states: CapabilityStateRecord[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(connectorCapabilityState).where(eq(connectorCapabilityState.connectorInstanceId, id));
      if (states.length === 0) return;
      await tx.insert(connectorCapabilityState).values(states.map((s) => ({ connectorInstanceId: id, capabilityId: s.capability, support: s.support, reason: s.reason ?? null, granted: s.granted })));
    });
  }

  async recordHealth(id: string, h: { result: 'ok' | 'warn' | 'fail'; detail?: Record<string, unknown>; latencyMs?: number }): Promise<void> {
    await this.db.insert(connectorHealthCheck).values({ connectorInstanceId: id, result: h.result, detail: h.detail ?? null, latencyMs: h.latencyMs ?? null });
  }
}
