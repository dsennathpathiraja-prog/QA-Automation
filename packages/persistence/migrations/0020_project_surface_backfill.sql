-- Complete Default-project ownership: remaining aggregates + executions; tighten nullable project_id columns.
-- New projects stay empty: only the Default id is used for backfill; create never copies rows.
UPDATE "workflow" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
UPDATE "test_case" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
UPDATE "test_collection" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "workflow" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "test_case" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "test_collection" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow_execution" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "workflow_execution" e
SET "project_id" = w."project_id"
FROM "workflow" w
WHERE e."workflow_id" = w."id" AND e."project_id" is null;
--> statement-breakpoint
UPDATE "workflow_execution" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "workflow_execution" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow_execution" ADD CONSTRAINT "workflow_execution_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_execution_project_idx" ON "workflow_execution" USING btree ("project_id");
--> statement-breakpoint
ALTER TABLE "work_item_execution" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "work_item_execution" x
SET "project_id" = e."project_id"
FROM "environment" e
WHERE x."environment_id" = e."id" AND x."project_id" is null;
--> statement-breakpoint
UPDATE "work_item_execution" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "work_item_execution" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "work_item_execution" ADD CONSTRAINT "work_item_execution_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_item_execution_project_idx" ON "work_item_execution" USING btree ("project_id");
--> statement-breakpoint
ALTER TABLE "automation_asset" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "automation_asset" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "automation_asset" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "automation_asset" ADD CONSTRAINT "automation_asset_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_asset_project_idx" ON "automation_asset" USING btree ("project_id");
--> statement-breakpoint
ALTER TABLE "automation_mapping" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "automation_mapping" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "automation_mapping" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "automation_mapping" ADD CONSTRAINT "automation_mapping_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_mapping_project_idx" ON "automation_mapping" USING btree ("project_id");
--> statement-breakpoint
ALTER TABLE "regression_collection" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "regression_collection" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "regression_collection" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "regression_collection" ADD CONSTRAINT "regression_collection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regression_collection_project_idx" ON "regression_collection" USING btree ("project_id");
