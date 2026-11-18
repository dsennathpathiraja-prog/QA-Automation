ALTER TABLE "workflow" DROP CONSTRAINT "workflow_status_ck";
--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_status_ck" CHECK ("status" in ('draft','in_review','published','disabled'));
--> statement-breakpoint
CREATE TABLE "workflow_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL REFERENCES "workflow"("id"),
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"definition" jsonb NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_version_uq" ON "workflow_version" USING btree ("workflow_id","version");
--> statement-breakpoint
CREATE TRIGGER workflow_version_append_only BEFORE UPDATE OR DELETE ON workflow_version FOR EACH ROW EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER workflow_version_no_truncate BEFORE TRUNCATE ON workflow_version FOR EACH STATEMENT EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TABLE "workflow_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL REFERENCES "workflow"("id"),
	"version_id" uuid NOT NULL REFERENCES "workflow_version"("id"),
	"status" text DEFAULT 'queued' NOT NULL,
	"step_index" integer DEFAULT 0 NOT NULL,
	"phase" text DEFAULT 'pending' NOT NULL,
	"control" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"definition" jsonb NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_execution_status_ck" CHECK ("status" in ('queued','running','paused','succeeded','failed','cancelled')),
	CONSTRAINT "workflow_execution_phase_ck" CHECK ("phase" in ('pending','effect'))
);
--> statement-breakpoint
CREATE INDEX "workflow_execution_status_idx" ON "workflow_execution" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "workflow_event" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL REFERENCES "workflow_execution"("id"),
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER workflow_event_append_only BEFORE UPDATE OR DELETE ON workflow_event FOR EACH ROW EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER workflow_event_no_truncate BEFORE TRUNCATE ON workflow_event FOR EACH STATEMENT EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TABLE "workflow_effect" (
	"execution_id" uuid NOT NULL REFERENCES "workflow_execution"("id"),
	"step_id" text NOT NULL,
	"effect_key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_effect_pkey" PRIMARY KEY ("execution_id","step_id","effect_key")
);
--> statement-breakpoint
CREATE TRIGGER workflow_effect_append_only BEFORE UPDATE OR DELETE ON workflow_effect FOR EACH ROW EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER workflow_effect_no_truncate BEFORE TRUNCATE ON workflow_effect FOR EACH STATEMENT EXECUTE FUNCTION qa_forbid_mutation();
