-- The owner asked for generated test cases to be stored in Squash (19 Nov 2026).
UPDATE "connector_instance"
SET "access_mode" = 'read_write'
WHERE "category" = 'test-management' AND "deleted_at" IS NULL AND "access_mode" = 'read_only';
