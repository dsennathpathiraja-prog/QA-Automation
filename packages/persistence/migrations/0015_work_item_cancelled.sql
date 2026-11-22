-- Allow cancelling a queued/running work-item execution (stops runner + frees pool).
ALTER TABLE "work_item_execution" DROP CONSTRAINT "work_item_execution_status_ck";
--> statement-breakpoint
ALTER TABLE "work_item_execution" ADD CONSTRAINT "work_item_execution_status_ck" CHECK ("status" in ('prepared','queued','running','completed','failed','cancelled'));
