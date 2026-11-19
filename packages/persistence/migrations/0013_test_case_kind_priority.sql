-- Case kind (positive / negative / edge) and priority for Test Cases UI.
ALTER TABLE "test_case" ADD COLUMN "kind" text DEFAULT 'positive' NOT NULL;
--> statement-breakpoint
ALTER TABLE "test_case" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
UPDATE "test_case" SET "kind" = 'negative', "priority" = 'high' WHERE "name" ~* '^negative\s*:';
--> statement-breakpoint
UPDATE "test_case" SET "kind" = 'edge', "priority" = 'low' WHERE "name" ~* '^edge\s*:';
--> statement-breakpoint
UPDATE "test_case" SET "kind" = 'positive', "priority" = 'medium' WHERE "name" ~* '^positive\s*:';
--> statement-breakpoint
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_kind_ck" CHECK ("kind" in ('positive', 'negative', 'edge'));
--> statement-breakpoint
ALTER TABLE "test_case" ADD CONSTRAINT "test_case_priority_ck" CHECK ("priority" in ('high', 'medium', 'low'));
