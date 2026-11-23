-- Slice B: workflow keys unique per project (not globally).
DROP INDEX IF EXISTS "workflow_key_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_project_key_uq" ON "workflow" USING btree ("project_id", "key") WHERE "deleted_at" is null;
