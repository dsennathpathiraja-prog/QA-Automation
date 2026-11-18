CREATE TABLE "connector_test_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_instance_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "connector_test_request_status_ck" CHECK ("connector_test_request"."status" in ('pending','running','succeeded','failed'))
);
--> statement-breakpoint
CREATE TABLE "secret_envelope" (
	"locator" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"wrapped_dek" text NOT NULL,
	"dek_iv" text NOT NULL,
	"dek_tag" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_test_request" ADD CONSTRAINT "connector_test_request_connector_instance_id_connector_instance_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_test_request_status_idx" ON "connector_test_request" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "connector_test_request_instance_idx" ON "connector_test_request" USING btree ("connector_instance_id","requested_at");