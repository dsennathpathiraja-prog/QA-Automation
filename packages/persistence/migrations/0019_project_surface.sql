-- Project surface foundation: platform Project aggregate + scope for connectors and environments.
-- Existing rows backfill onto a system Default project. Workflows/cases get nullable project_id for follow-up slices.
CREATE TABLE IF NOT EXISTS "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_status_ck" CHECK ("status" in ('active','archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_key_uq" ON "project" USING btree ("key") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_name_uq" ON "project" USING btree (lower("name")) WHERE "deleted_at" is null;
--> statement-breakpoint
INSERT INTO "project" ("id", "key", "name", "description", "status")
SELECT '01900000-0000-7000-8000-000000000001', 'default', 'Default', 'Migrated from unscoped platform data.', 'active'
WHERE NOT EXISTS (SELECT 1 FROM "project" WHERE "key" = 'default' AND "deleted_at" is null);
--> statement-breakpoint
ALTER TABLE "connector_instance" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "connector_instance" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "connector_instance" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connector_instance" ADD CONSTRAINT "connector_instance_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "connector_instance_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_instance_project_name_uq" ON "connector_instance" USING btree ("project_id", "provider_key", "name") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_instance_project_idx" ON "connector_instance" USING btree ("project_id") WHERE "deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "environment" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
ALTER TABLE "environment" ALTER COLUMN "project_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "environment" ADD CONSTRAINT "environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_project_name_uq" ON "environment" USING btree ("project_id", "name") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_project_idx" ON "environment" USING btree ("project_id") WHERE "deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "workflow" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "workflow" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow" ADD CONSTRAINT "workflow_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_project_idx" ON "workflow" USING btree ("project_id") WHERE "deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "test_case" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "test_case" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "test_case" ADD CONSTRAINT "test_case_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_case_project_idx" ON "test_case" USING btree ("project_id") WHERE "deleted_at" is null;
--> statement-breakpoint
ALTER TABLE "test_collection" ADD COLUMN IF NOT EXISTS "project_id" uuid;
--> statement-breakpoint
UPDATE "test_collection" SET "project_id" = '01900000-0000-7000-8000-000000000001' WHERE "project_id" is null;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "test_collection" ADD CONSTRAINT "test_collection_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "project"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_collection_project_idx" ON "test_collection" USING btree ("project_id") WHERE "deleted_at" is null;
