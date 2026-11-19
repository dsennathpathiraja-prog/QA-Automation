ALTER TABLE "environment" ADD COLUMN "reachability" text DEFAULT 'not-run' NOT NULL;
--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "reachability_detail" text;
--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "reachability_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_reachability_ck" CHECK ("reachability" in ('not-run','queued','checking','reachable','unreachable'));
