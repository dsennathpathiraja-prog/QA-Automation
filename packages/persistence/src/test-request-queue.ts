import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { TestRequestQueue, TestRequestRecord, TestResult } from '@qa/application';
import type { Db } from './db';
import { connectorTestRequest } from './schema';

type Row = typeof connectorTestRequest.$inferSelect;

const toRecord = (r: Row): TestRequestRecord => ({
  id: r.id,
  connectorId: r.connectorInstanceId,
  configVersion: r.configVersion,
  status: r.status as TestRequestRecord['status'],
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  startedAt: r.startedAt ?? undefined,
  finishedAt: r.finishedAt ?? undefined,
  result: (r.result ?? undefined) as TestResult | undefined,
});

export class PgTestRequestQueue implements TestRequestQueue {
  constructor(private readonly db: Db) {}

  async enqueue(connectorId: string, configVersion: number, requestedBy: string): Promise<TestRequestRecord> {
    return this.db.transaction(async (tx) => {
      // Serialise per connector so two clicks cannot queue two tests.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${connectorId}))`);
      const [open] = await tx
        .select()
        .from(connectorTestRequest)
        .where(and(eq(connectorTestRequest.connectorInstanceId, connectorId), inArray(connectorTestRequest.status, ['pending', 'running'])))
        .limit(1);
      if (open) return toRecord(open);
      const [row] = await tx.insert(connectorTestRequest).values({ connectorInstanceId: connectorId, configVersion, requestedBy }).returning();
      return toRecord(row!);
    });
  }

  async latest(connectorId: string): Promise<TestRequestRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(connectorTestRequest)
      .where(eq(connectorTestRequest.connectorInstanceId, connectorId))
      .orderBy(desc(connectorTestRequest.requestedAt), desc(connectorTestRequest.id))
      .limit(1);
    return row && toRecord(row);
  }

  async claimNext(): Promise<TestRequestRecord | undefined> {
    const res = await this.db.execute(sql`
      update connector_test_request set status = 'running', started_at = now()
      where id = (
        select id from connector_test_request where status = 'pending'
        order by requested_at, id for update skip locked limit 1
      )
      returning id`);
    const id = (res as unknown as { rows: { id: string }[] }).rows[0]?.id;
    if (!id) return undefined;
    const [row] = await this.db.select().from(connectorTestRequest).where(eq(connectorTestRequest.id, id)).limit(1);
    return row && toRecord(row);
  }

  async finish(id: string, status: 'succeeded' | 'failed', result: TestResult): Promise<void> {
    await this.db.update(connectorTestRequest).set({ status, result: result as unknown as Record<string, unknown>, finishedAt: new Date() }).where(eq(connectorTestRequest.id, id));
  }

  async failStale(before: Date): Promise<number> {
    const rows = await this.db
      .update(connectorTestRequest)
      .set({ status: 'failed', finishedAt: new Date(), result: { ok: false, message: 'The test did not finish. Try again.', errorClass: 'transient' } })
      .where(and(eq(connectorTestRequest.status, 'running'), lt(connectorTestRequest.startedAt, before)))
      .returning({ id: connectorTestRequest.id });
    return rows.length;
  }
}
