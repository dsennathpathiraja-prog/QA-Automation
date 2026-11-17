CREATE TRIGGER llm_call_log_append_only BEFORE UPDATE OR DELETE ON llm_call_log FOR EACH ROW EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER llm_call_log_no_truncate BEFORE TRUNCATE ON llm_call_log FOR EACH STATEMENT EXECUTE FUNCTION qa_forbid_mutation();
