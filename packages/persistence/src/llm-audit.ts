import type { LlmAuditEntry, LlmAuditSink } from '@qa/llm';
import type { Db } from './db';
import { llmCallLog } from './schema';

export class PgLlmAuditSink implements LlmAuditSink {
  constructor(private readonly db: Db) {}

  async append(e: LlmAuditEntry): Promise<void> {
    await this.db.insert(llmCallLog).values({
      at: e.at,
      agentKey: e.agentKey,
      executionId: e.executionId ?? null,
      stepId: e.stepId ?? null,
      providerId: e.providerId ?? null,
      providerKind: e.providerKind ?? null,
      model: e.model ?? null,
      dataClasses: e.dataClasses,
      contextItems: e.contextItems,
      droppedImages: e.droppedImages ?? null,
      outcome: e.outcome,
      refusalReason: e.refusalReason ?? null,
      errorClass: e.errorClass ?? null,
      inputTokens: e.usage?.inputTokens ?? null,
      outputTokens: e.usage?.outputTokens ?? null,
      durationMs: e.durationMs,
      promptDigest: e.promptDigest ?? null,
    });
  }
}
