import type { OperationLogEntry, OperationLogSink } from '@qa/connector-sdk';
import type { Db } from './db';
import { connectorOperationLog } from './schema';

export class PgOperationLogSink implements OperationLogSink {
  constructor(private readonly db: Db) {}

  async append(e: OperationLogEntry): Promise<void> {
    await this.db.insert(connectorOperationLog).values({
      at: e.at,
      executionId: e.executionId ?? null,
      stepId: e.stepId ?? null,
      actorType: e.actorType,
      actorId: e.actorId,
      connectorInstanceId: e.connectorInstanceId ?? null,
      capability: e.capability,
      access: e.access ?? null,
      outcome: e.outcome,
      denialReason: e.denialReason ?? null,
      errorClass: e.errorClass ?? null,
      requestDigest: e.requestDigest,
      idempotencyKey: e.idempotencyKey ?? null,
      durationMs: e.durationMs,
    });
  }
}
