CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workflow_type_ck" CHECK ("type" in ('requirement-validation','regression-testing')),
	CONSTRAINT "workflow_status_ck" CHECK ("status" in ('draft','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_key_uq" ON "workflow" USING btree ("key") WHERE "deleted_at" is null;
