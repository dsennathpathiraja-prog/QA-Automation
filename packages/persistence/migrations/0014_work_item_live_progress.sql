-- Live work-item run progress: Queued/Running case statuses and per-step JSON.
ALTER TABLE "work_item_case_result" DROP CONSTRAINT "work_item_case_result_status_ck";
--> statement-breakpoint
ALTER TABLE "work_item_case_result" ADD CONSTRAINT "work_item_case_result_status_ck" CHECK ("status" in ('Queued', 'Running', 'Passed', 'Failed', 'Blocked', 'Skipped'));
--> statement-breakpoint
ALTER TABLE "work_item_case_result" ADD COLUMN "steps_json" text;
