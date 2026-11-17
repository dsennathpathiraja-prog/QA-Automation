CREATE TABLE "llm_call_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"agent_key" text NOT NULL,
	"execution_id" text,
	"step_id" text,
	"provider_id" text,
	"provider_kind" text,
	"model" text,
	"data_classes" jsonb NOT NULL,
	"context_items" integer NOT NULL,
	"dropped_images" integer,
	"outcome" text NOT NULL,
	"refusal_reason" text,
	"error_class" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer NOT NULL,
	"prompt_digest" text,
	CONSTRAINT "llm_call_outcome_ck" CHECK ("llm_call_log"."outcome" in ('success','refused','failed','fallback'))
);
--> statement-breakpoint
CREATE INDEX "llm_call_log_exec_idx" ON "llm_call_log" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "llm_call_log_at_idx" ON "llm_call_log" USING btree ("at");