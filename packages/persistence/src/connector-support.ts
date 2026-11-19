import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import type { InstanceResolver, ResolvedInstance, CapabilityId, ConnectorCategory, ConnectorScope } from '@qa/connector-sdk';
import { connectorSecretLocator, type OperationLogReader, type OperationLogRow } from '@qa/application';
import type { AuditSink } from '@qa/application';
import type { AuditEntryInput } from '@qa/security';
import type { Db } from './db';
import { connectorCapabilityState, connectorInstance, connectorOperationLog } from './schema';
import type { PgAuditLog } from './audit-log';

const SCOPE_KEYS = ['project', 'org', 'repo', 'branch'] as const;

const scopeOf = (config: Record<string, unknown>): ConnectorScope => {
  const base = (typeof config.scope === 'object' && config.scope ? (config.scope as Record<string, unknown>) : config) ?? {};
  const out: ConnectorScope = {};
  for (const k of SCOPE_KEYS) if (typeof base[k] === 'string' && base[k]) out[k] = base[k] as string;
  return out;
};

/** Resolves live (not deleted) connector instances for the Connector Execution Manager. */
export class PgInstanceResolver implements InstanceResolver {
  constructor(
    private readonly db: Db,
    private readonly secretExists: (locator: string) => Promise<boolean> = async () => true,
  ) {}

  async getById(id: string): Promise<ResolvedInstance | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
    const [r] = await this.db.select().from(connectorInstance).where(and(eq(connectorInstance.id, id), isNull(connectorInstance.deletedAt))).limit(1);
    if (!r) return undefined;
    const states = await this.db.select().from(connectorCapabilityState).where(eq(connectorCapabilityState.connectorInstanceId, id));
    const locator = connectorSecretLocator(id);
    return {
      id: r.id,
      providerKey: r.providerKey,
      category: r.category as ConnectorCategory,
      enabled: r.enabled,
      status: r.status as ResolvedInstance['status'],
      accessMode: r.accessMode as ResolvedInstance['accessMode'],
      config: r.config,
      scope: scopeOf(r.config),
      secretLocator: (await this.secretExists(locator)) ? locator : undefined,
      effectiveCapabilities: new Set([
        ...states.filter((s) => s.granted && s.support !== 'unsupported').map((s) => s.capabilityId as CapabilityId),
        ...(r.category === 'test-management' && r.accessMode === 'read_write' ? ['tm.testcase.upsert' as CapabilityId] : []),
      ]),
    };
  }
}

export class PgOperationLogReader implements OperationLogReader {
  constructor(private readonly db: Db) {}

  async list(f: Parameters<OperationLogReader['list']>[0]): Promise<OperationLogRow[]> {
    const t = connectorOperationLog;
    const conds = [
      f.connectorInstanceId ? eq(t.connectorInstanceId, f.connectorInstanceId) : undefined,
      f.outcome ? eq(t.outcome, f.outcome) : undefined,
      f.capability ? eq(t.capability, f.capability) : undefined,
      f.beforeSeq ? lt(t.seq, f.beforeSeq) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await this.db.select().from(t).where(and(...conds)).orderBy(desc(t.seq)).limit(f.limit);
    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      executionId: r.executionId ?? undefined,
      actorType: r.actorType,
      actorId: r.actorId,
      connectorInstanceId: r.connectorInstanceId ?? undefined,
      capability: r.capability,
      access: r.access ?? undefined,
      outcome: r.outcome,
      denialReason: r.denialReason ?? undefined,
      errorClass: r.errorClass ?? undefined,
      durationMs: r.durationMs,
    }));
  }
}

export class PgAuditSink implements AuditSink {
  constructor(
    private readonly log: PgAuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(e: Omit<AuditEntryInput, 'at'>) {
    return this.log.append({ ...e, at: this.now().toISOString() });
  }
}
