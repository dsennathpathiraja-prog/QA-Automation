-- Slice C: test case keys and collection names unique per project (not globally).
DROP INDEX IF EXISTS "test_case_key_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "test_case_project_key_uq" ON "test_case" USING btree ("project_id", "key") WHERE "deleted_at" is null;
--> statement-breakpoint
DROP INDEX IF EXISTS "test_collection_name_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "test_collection_project_name_uq" ON "test_collection" USING btree ("project_id", "name") WHERE "deleted_at" is null;
