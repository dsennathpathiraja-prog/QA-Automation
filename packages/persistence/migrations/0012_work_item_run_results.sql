-- Phase 7: run a prepared work item, store per-case results and screenshots.
ALTER TABLE "work_item_execution" DROP CONSTRAINT "work_item_execution_status_ck";
--> statement-breakpoint
ALTER TABLE "work_item_execution" ADD CONSTRAINT "work_item_execution_status_ck" CHECK ("status" in ('prepared', 'queued', 'running', 'completed', 'failed'));
--> statement-breakpoint
ALTER TABLE "work_item_execution" ADD COLUMN "squash_sync" text;
--> statement-breakpoint
ALTER TABLE "work_item_execution" ADD COLUMN "finished_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "work_item_case_result" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "execution_id" uuid NOT NULL REFERENCES "work_item_execution"("id") ON DELETE CASCADE,
  "test_case_id" uuid NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL,
  "message" text NOT NULL DEFAULT '',
  "screenshot_png" text,
  "squash_execution_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "work_item_case_result_status_ck" CHECK ("status" in ('Passed', 'Failed', 'Blocked', 'Skipped'))
);
--> statement-breakpoint
CREATE INDEX "work_item_case_result_execution_idx" ON "work_item_case_result" USING btree ("execution_id");
