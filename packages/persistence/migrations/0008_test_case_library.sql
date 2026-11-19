CREATE TABLE "test_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "test_case_key_uq" ON "test_case" USING btree ("key") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE TABLE "test_case_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_case_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"steps" text NOT NULL,
	"expected" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "test_case_version_uq" ON "test_case_version" USING btree ("test_case_id","version");
--> statement-breakpoint
CREATE TABLE "test_collection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "test_collection_name_uq" ON "test_collection" USING btree ("name") WHERE "deleted_at" is null;
--> statement-breakpoint
CREATE TABLE "test_collection_case" (
	"collection_id" uuid NOT NULL,
	"test_case_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "test_collection_case_pk" PRIMARY KEY("collection_id","test_case_id")
);
