-- Phase 9 E4: curated platform regression collections (smoke) with Squash case id members.
CREATE TABLE IF NOT EXISTS "regression_collection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "regression_collection_key_uq" ON "regression_collection" USING btree ("key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "regression_collection_member" (
	"collection_id" uuid NOT NULL,
	"squash_case_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "regression_collection_member_pk" PRIMARY KEY("collection_id","squash_case_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "regression_collection_member_collection_idx" ON "regression_collection_member" USING btree ("collection_id");
