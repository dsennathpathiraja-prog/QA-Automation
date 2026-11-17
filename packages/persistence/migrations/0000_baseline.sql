CREATE TABLE "app_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"groups" jsonb NOT NULL,
	"roles" jsonb NOT NULL,
	"csrf_token" text NOT NULL,
	"id_token" text NOT NULL,
	"idp_session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_subject" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "app_user_status_ck" CHECK ("app_user"."status" in ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"at" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"detail" jsonb,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "auth_profile_type_ck" CHECK ("auth_profile"."type" in ('none','basic','form-login','bearer','storage-state'))
);
--> statement-breakpoint
CREATE TABLE "connector_capability_state" (
	"connector_instance_id" uuid NOT NULL,
	"capability_id" text NOT NULL,
	"support" text NOT NULL,
	"reason" text,
	"probe_evidence" jsonb,
	"granted" boolean DEFAULT false NOT NULL,
	"probed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_capability_state_connector_instance_id_capability_id_pk" PRIMARY KEY("connector_instance_id","capability_id"),
	CONSTRAINT "connector_cap_support_ck" CHECK ("connector_capability_state"."support" in ('supported','partial','unsupported'))
);
--> statement-breakpoint
CREATE TABLE "connector_health_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_instance_id" uuid NOT NULL,
	"result" text NOT NULL,
	"detail" jsonb,
	"latency_ms" integer,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_health_result_ck" CHECK ("connector_health_check"."result" in ('ok','warn','fail'))
);
--> statement-breakpoint
CREATE TABLE "connector_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_key" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"access_mode" text DEFAULT 'read_only' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permission_report" jsonb,
	"discovered_info" jsonb,
	"config_version" integer DEFAULT 1 NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_tested_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "connector_category_ck" CHECK ("connector_instance"."category" in ('work-item','source-repo','browser-automation','test-management','test-runner')),
	CONSTRAINT "connector_status_ck" CHECK ("connector_instance"."status" in ('draft','connected','degraded','error','disconnected')),
	CONSTRAINT "connector_access_ck" CHECK ("connector_instance"."access_mode" in ('read_only','read_write')),
	CONSTRAINT "connector_source_repo_ro_ck" CHECK ("connector_instance"."category" <> 'source-repo' or "connector_instance"."access_mode" = 'read_only')
);
--> statement-breakpoint
CREATE TABLE "connector_operation_log" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"execution_id" text,
	"step_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"connector_instance_id" text,
	"capability" text NOT NULL,
	"access" text,
	"outcome" text NOT NULL,
	"denial_reason" text,
	"error_class" text,
	"request_digest" text NOT NULL,
	"idempotency_key" text,
	"duration_ms" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "egress_allowlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_pattern" text NOT NULL,
	"purpose" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"allow_http" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_purpose_ck" CHECK ("egress_allowlist"."purpose" in ('connector','application','registry','llm')),
	CONSTRAINT "egress_http_internal_ck" CHECK ("egress_allowlist"."allow_http" = false or "egress_allowlist"."internal" = true)
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"application_url" text NOT NULL,
	"browser_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"execution_restrictions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "environment_kind_ck" CHECK ("environment"."kind" in ('development','qa','staging','uat','production'))
);
--> statement-breakpoint
CREATE TABLE "environment_authorization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"justification" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "env_auth_status_ck" CHECK ("environment_authorization"."status" in ('active','revoked','expired')),
	CONSTRAINT "env_auth_window_ck" CHECK ("environment_authorization"."valid_until" > "environment_authorization"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "environment_connector_ref" (
	"environment_id" uuid NOT NULL,
	"connector_instance_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "environment_connector_ref_environment_id_role_pk" PRIMARY KEY("environment_id","role")
);
--> statement-breakpoint
CREATE TABLE "identity_provider_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_ref_id" uuid,
	"group_claim" text DEFAULT 'groups' NOT NULL,
	"group_format" text DEFAULT 'name' NOT NULL,
	"break_glass_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "idp_cfg_format_ck" CHECK ("identity_provider_config"."group_format" in ('name','path','object-id'))
);
--> statement-breakpoint
CREATE TABLE "idp_group_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idp_group" text NOT NULL,
	"role_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"system_defined" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "role_permission_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "secret_ref" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store" text NOT NULL,
	"locator" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"purpose" text DEFAULT 'credentials' NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "secret_ref_store_ck" CHECK ("secret_ref"."store" in ('openbao','azure-key-vault','aws-secrets-manager','db-envelope'))
);
--> statement-breakpoint
CREATE TABLE "test_data_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"row_version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"source" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_user_id_role_id_pk" PRIMARY KEY("user_id","role_id"),
	CONSTRAINT "user_role_source_ck" CHECK ("user_role"."source" in ('idp','manual')),
	CONSTRAINT "user_role_granted_by_ck" CHECK ("user_role"."source" = 'manual' or "user_role"."granted_by" is null)
);
--> statement-breakpoint
ALTER TABLE "auth_profile" ADD CONSTRAINT "auth_profile_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_capability_state" ADD CONSTRAINT "connector_capability_state_connector_instance_id_connector_instance_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_health_check" ADD CONSTRAINT "connector_health_check_connector_instance_id_connector_instance_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "egress_allowlist" ADD CONSTRAINT "egress_allowlist_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_authorization" ADD CONSTRAINT "environment_authorization_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_authorization" ADD CONSTRAINT "environment_authorization_granted_by_app_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_connector_ref" ADD CONSTRAINT "environment_connector_ref_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_connector_ref" ADD CONSTRAINT "environment_connector_ref_connector_instance_id_connector_instance_id_fk" FOREIGN KEY ("connector_instance_id") REFERENCES "public"."connector_instance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_provider_config" ADD CONSTRAINT "identity_provider_config_client_secret_ref_id_secret_ref_id_fk" FOREIGN KEY ("client_secret_ref_id") REFERENCES "public"."secret_ref"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idp_group_mapping" ADD CONSTRAINT "idp_group_mapping_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_setting" ADD CONSTRAINT "platform_setting_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_data_profile" ADD CONSTRAINT "test_data_profile_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_data_profile" ADD CONSTRAINT "test_data_profile_secret_ref_id_secret_ref_id_fk" FOREIGN KEY ("secret_ref_id") REFERENCES "public"."secret_ref"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_granted_by_app_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_session_idp_idx" ON "app_session" USING btree ("idp_session_id");--> statement-breakpoint
CREATE INDEX "app_session_user_idx" ON "app_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "app_session_expiry_idx" ON "app_session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_subject_uq" ON "app_user" USING btree ("external_subject");--> statement-breakpoint
CREATE INDEX "audit_log_subject_idx" ON "audit_log" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_profile_name_uq" ON "auth_profile" USING btree ("environment_id","name");--> statement-breakpoint
CREATE INDEX "connector_health_idx" ON "connector_health_check" USING btree ("connector_instance_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_instance_name_uq" ON "connector_instance" USING btree ("provider_key","name") WHERE "connector_instance"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "connector_oplog_exec_idx" ON "connector_operation_log" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "connector_oplog_at_idx" ON "connector_operation_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "egress_allowlist_host_uq" ON "egress_allowlist" USING btree (lower("host_pattern"),"purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_name_uq" ON "environment" USING btree ("name") WHERE "environment"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "env_auth_one_active_uq" ON "environment_authorization" USING btree ("environment_id") WHERE "environment_authorization"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "idp_group_mapping_group_uq" ON "idp_group_mapping" USING btree (lower("idp_group"));--> statement-breakpoint
CREATE UNIQUE INDEX "role_key_uq" ON "role" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_ref_owner_purpose_uq" ON "secret_ref" USING btree ("owner_type","owner_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_ref_locator_uq" ON "secret_ref" USING btree ("store","locator");--> statement-breakpoint
CREATE UNIQUE INDEX "test_data_profile_name_uq" ON "test_data_profile" USING btree ("environment_id","name");