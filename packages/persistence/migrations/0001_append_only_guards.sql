CREATE FUNCTION qa_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER connector_operation_log_append_only BEFORE UPDATE OR DELETE ON connector_operation_log FOR EACH ROW EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER connector_operation_log_no_truncate BEFORE TRUNCATE ON connector_operation_log FOR EACH STATEMENT EXECUTE FUNCTION qa_forbid_mutation();
--> statement-breakpoint
CREATE FUNCTION qa_connector_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_key IS DISTINCT FROM OLD.provider_key OR NEW.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION 'connector_instance.provider_key and category are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER connector_instance_identity_immutable BEFORE UPDATE ON connector_instance FOR EACH ROW EXECUTE FUNCTION qa_connector_identity_immutable();
