-- Phase 8 E6: draft→approved automation assets + Squash case ↔ platform script mapping.
CREATE TABLE IF NOT EXISTS "automation_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"script_path" text NOT NULL,
	"script_body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"test_case_id" uuid,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_asset_status_ck" CHECK ("status" in ('draft','approved'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "automation_asset_key_uq" ON "automation_asset" USING btree ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_asset_status_idx" ON "automation_asset" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"squash_case_id" text NOT NULL,
	"squash_reference" text DEFAULT '' NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "automation_mapping_squash_uq" ON "automation_mapping" USING btree ("squash_case_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automation_mapping_asset_idx" ON "automation_mapping" USING btree ("asset_id");
