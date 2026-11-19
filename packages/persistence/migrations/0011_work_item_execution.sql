CREATE TABLE "work_item_execution" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "work_item" text NOT NULL,
  "environment_id" uuid NOT NULL,
  "environment_name" text NOT NULL,
  "case_count" integer NOT NULL,
  "status" text DEFAULT 'prepared' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "work_item_execution_status_ck" CHECK ("status" in ('prepared'))
);
--> statement-breakpoint
CREATE INDEX "work_item_execution_created_idx" ON "work_item_execution" USING btree ("created_at");
