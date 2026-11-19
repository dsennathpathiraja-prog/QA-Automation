import { sql } from 'drizzle-orm';
import {
  bigserial, boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);
const audit = () => ({
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  rowVersion: integer('row_version').notNull().default(1),
});

/* ---------- identity ---------- */

export const appUser = pgTable(
  'app_user',
  {
    id: id(),
    externalSubject: text('external_subject').notNull(),
    email: text('email'),
    displayName: text('display_name').notNull(),
    status: text('status').notNull().default('active'),
    lastLoginAt: ts('last_login_at'),
    ...audit(),
  },
  (t) => [
    uniqueIndex('app_user_subject_uq').on(t.externalSubject),
    check('app_user_status_ck', sql`${t.status} in ('active','disabled')`),
  ],
);

export const role = pgTable(
  'role',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    systemDefined: boolean('system_defined').notNull().default(true),
  },
  (t) => [uniqueIndex('role_key_uq').on(t.key)],
);

export const rolePermission = pgTable(
  'role_permission',
  {
    roleId: uuid('role_id').notNull().references(() => role.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRole = pgTable(
  'user_role',
  {
    userId: uuid('user_id').notNull().references(() => appUser.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id').notNull().references(() => role.id),
    source: text('source').notNull(),
    grantedBy: uuid('granted_by').references(() => appUser.id),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    check('user_role_source_ck', sql`${t.source} in ('idp','manual')`),
    check('user_role_granted_by_ck', sql`${t.source} = 'manual' or ${t.grantedBy} is null`),
  ],
);

export const idpGroupMapping = pgTable(
  'idp_group_mapping',
  {
    id: id(),
    idpGroup: text('idp_group').notNull(),
    roleId: uuid('role_id').notNull().references(() => role.id),
    enabled: boolean('enabled').notNull().default(true),
    ...audit(),
  },
  (t) => [uniqueIndex('idp_group_mapping_group_uq').on(sql`lower(${t.idpGroup})`)],
);

export const secretRef = pgTable(
  'secret_ref',
  {
    id: id(),
    store: text('store').notNull(),
    locator: text('locator').notNull(),
    version: integer('version').notNull().default(1),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    purpose: text('purpose').notNull().default('credentials'),
    rotatedAt: ts('rotated_at'),
    ...audit(),
  },
  (t) => [
    uniqueIndex('secret_ref_owner_purpose_uq').on(t.ownerType, t.ownerId, t.purpose),
    uniqueIndex('secret_ref_locator_uq').on(t.store, t.locator),
    check('secret_ref_store_ck', sql`${t.store} in ('openbao','azure-key-vault','aws-secrets-manager','db-envelope')`),
  ],
);

export const identityProviderConfig = pgTable('identity_provider_config', {
  id: id(),
  issuer: text('issuer').notNull(),
  clientId: text('client_id').notNull(),
  clientSecretRefId: uuid('client_secret_ref_id').references(() => secretRef.id),
  groupClaim: text('group_claim').notNull().default('groups'),
  groupFormat: text('group_format').notNull().default('name'),
  breakGlassEnabled: boolean('break_glass_enabled').notNull().default(false),
  ...audit(),
}, (t) => [check('idp_cfg_format_ck', sql`${t.groupFormat} in ('name','path','object-id')`)]);

/** Server-side login sessions. Only a SHA-256 of the cookie token is stored, so a database read cannot be replayed. */
export const appSession = pgTable(
  'app_session',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    groups: jsonb('groups').$type<string[]>().notNull(),
    roles: jsonb('roles').$type<string[]>().notNull(),
    csrfToken: text('csrf_token').notNull(),
    idToken: text('id_token').notNull(),
    idpSessionId: text('idp_session_id'),
    createdAt: ts('created_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('app_session_idp_idx').on(t.idpSessionId), index('app_session_user_idx').on(t.userId), index('app_session_expiry_idx').on(t.expiresAt)],
);

/* ---------- connectors ---------- */

export const connectorInstance = pgTable(
  'connector_instance',
  {
    id: id(),
    providerKey: text('provider_key').notNull(),
    category: text('category').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    enabled: boolean('enabled').notNull().default(false),
    accessMode: text('access_mode').notNull().default('read_only'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    permissionReport: jsonb('permission_report').$type<Record<string, unknown>>(),
    discoveredInfo: jsonb('discovered_info').$type<Record<string, unknown>>(),
    configVersion: integer('config_version').notNull().default(1),
    managed: boolean('managed').notNull().default(false),
    lastSuccessAt: ts('last_success_at'),
    lastTestedAt: ts('last_tested_at'),
    deletedAt: ts('deleted_at'),
    ...audit(),
  },
  (t) => [
    uniqueIndex('connector_instance_name_uq').on(t.providerKey, t.name).where(sql`${t.deletedAt} is null`),
    check('connector_category_ck', sql`${t.category} in ('work-item','source-repo','browser-automation','test-management','test-runner')`),
    check('connector_status_ck', sql`${t.status} in ('draft','connected','degraded','error','disconnected')`),
    check('connector_access_ck', sql`${t.accessMode} in ('read_only','read_write')`),
    // Read-only source repositories are enforced here as well as in the registry and the HTTP layer.
    check('connector_source_repo_ro_ck', sql`${t.category} <> 'source-repo' or ${t.accessMode} = 'read_only'`),
  ],
);

export const connectorHealthCheck = pgTable(
  'connector_health_check',
  {
    id: id(),
    connectorInstanceId: uuid('connector_instance_id').notNull().references(() => connectorInstance.id),
    result: text('result').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    latencyMs: integer('latency_ms'),
    checkedAt: ts('checked_at').notNull().defaultNow(),
  },
  (t) => [index('connector_health_idx').on(t.connectorInstanceId, t.checkedAt), check('connector_health_result_ck', sql`${t.result} in ('ok','warn','fail')`)],
);

export const connectorCapabilityState = pgTable(
  'connector_capability_state',
  {
    connectorInstanceId: uuid('connector_instance_id').notNull().references(() => connectorInstance.id),
    capabilityId: text('capability_id').notNull(),
    support: text('support').notNull(),
    reason: text('reason'),
    probeEvidence: jsonb('probe_evidence').$type<Record<string, unknown>>(),
    granted: boolean('granted').notNull().default(false),
    probedAt: ts('probed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectorInstanceId, t.capabilityId] }), check('connector_cap_support_ck', sql`${t.support} in ('supported','partial','unsupported')`)],
);

/** Test Connection requests. The API enqueues; the worker, the only reader of connector secrets, runs them. */
export const connectorTestRequest = pgTable(
  'connector_test_request',
  {
    id: id(),
    connectorInstanceId: uuid('connector_instance_id').notNull().references(() => connectorInstance.id),
    configVersion: integer('config_version').notNull(),
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    result: jsonb('result').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('connector_test_request_status_idx').on(t.status, t.requestedAt),
    index('connector_test_request_instance_idx').on(t.connectorInstanceId, t.requestedAt),
    check('connector_test_request_status_ck', sql`${t.status} in ('pending','running','succeeded','failed')`),
  ],
);

/** Ciphertext of the dev/CI `db-envelope` secret store. Never used when OpenBao is configured. */
export const secretEnvelope = pgTable('secret_envelope', {
  locator: text('locator').primaryKey(),
  version: integer('version').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  dekIv: text('dek_iv').notNull(),
  dekTag: text('dek_tag').notNull(),
  iv: text('iv').notNull(),
  tag: text('tag').notNull(),
  ciphertext: text('ciphertext').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Append-only (trigger-enforced). One row per connector call, written by the Connector Execution Manager. */
export const connectorOperationLog = pgTable(
  'connector_operation_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull(),
    executionId: text('execution_id'),
    stepId: text('step_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    connectorInstanceId: text('connector_instance_id'),
    capability: text('capability').notNull(),
    access: text('access'),
    outcome: text('outcome').notNull(),
    denialReason: text('denial_reason'),
    errorClass: text('error_class'),
    requestDigest: text('request_digest').notNull(),
    idempotencyKey: text('idempotency_key'),
    durationMs: integer('duration_ms').notNull(),
  },
  (t) => [index('connector_oplog_exec_idx').on(t.executionId), index('connector_oplog_at_idx').on(t.at)],
);

/** Append-only (trigger-enforced). One row per model call; stores a digest of the prompt, never its content. */
export const llmCallLog = pgTable(
  'llm_call_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull(),
    agentKey: text('agent_key').notNull(),
    executionId: text('execution_id'),
    stepId: text('step_id'),
    providerId: text('provider_id'),
    providerKind: text('provider_kind'),
    model: text('model'),
    dataClasses: jsonb('data_classes').$type<string[]>().notNull(),
    contextItems: integer('context_items').notNull(),
    droppedImages: integer('dropped_images'),
    outcome: text('outcome').notNull(),
    refusalReason: text('refusal_reason'),
    errorClass: text('error_class'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    durationMs: integer('duration_ms').notNull(),
    promptDigest: text('prompt_digest'),
  },
  (t) => [
    index('llm_call_log_exec_idx').on(t.executionId),
    index('llm_call_log_at_idx').on(t.at),
    check('llm_call_outcome_ck', sql`${t.outcome} in ('success','refused','failed','fallback')`),
  ],
);

/* ---------- environments ---------- */

export const environment = pgTable(
  'environment',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    applicationUrl: text('application_url').notNull(),
    browserConfig: jsonb('browser_config').$type<Record<string, unknown>>().notNull().default({}),
    executionRestrictions: jsonb('execution_restrictions').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    reachability: text('reachability').notNull().default('not-run'),
    reachabilityDetail: text('reachability_detail'),
    reachabilityCheckedAt: ts('reachability_checked_at'),
    deletedAt: ts('deleted_at'),
    ...audit(),
  },
  (t) => [
    uniqueIndex('environment_name_uq').on(t.name).where(sql`${t.deletedAt} is null`),
    check('environment_kind_ck', sql`${t.kind} in ('development','qa','staging','uat','production')`),
    check('environment_reachability_ck', sql`${t.reachability} in ('not-run','queued','checking','reachable','unreachable')`),
  ],
);

export const environmentConnectorRef = pgTable(
  'environment_connector_ref',
  {
    environmentId: uuid('environment_id').notNull().references(() => environment.id),
    connectorInstanceId: uuid('connector_instance_id').notNull().references(() => connectorInstance.id),
    role: text('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.role] })],
);

export const authProfile = pgTable(
  'auth_profile',
  {
    id: id(),
    environmentId: uuid('environment_id').notNull().references(() => environment.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    ...audit(),
  },
  (t) => [uniqueIndex('auth_profile_name_uq').on(t.environmentId, t.name), check('auth_profile_type_ck', sql`${t.type} in ('none','basic','form-login','bearer','storage-state')`)],
);

export const testDataProfile = pgTable(
  'test_data_profile',
  {
    id: id(),
    environmentId: uuid('environment_id').notNull().references(() => environment.id),
    name: text('name').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    secretRefId: uuid('secret_ref_id').references(() => secretRef.id),
    ...audit(),
  },
  (t) => [uniqueIndex('test_data_profile_name_uq').on(t.environmentId, t.name)],
);

export const environmentAuthorization = pgTable(
  'environment_authorization',
  {
    id: id(),
    environmentId: uuid('environment_id').notNull().references(() => environment.id),
    grantedBy: uuid('granted_by').notNull().references(() => appUser.id),
    justification: text('justification').notNull(),
    validFrom: ts('valid_from').notNull(),
    validUntil: ts('valid_until').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('env_auth_status_ck', sql`${t.status} in ('active','revoked','expired')`),
    check('env_auth_window_ck', sql`${t.validUntil} > ${t.validFrom}`),
    uniqueIndex('env_auth_one_active_uq').on(t.environmentId).where(sql`${t.status} = 'active'`),
  ],
);

/* ---------- workflows ---------- */

export const workflow = pgTable(
  'workflow',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    type: text('type').notNull(),
    status: text('status').notNull().default('draft'),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    deletedAt: ts('deleted_at'),
    ...audit(),
  },
  (t) => [
    uniqueIndex('workflow_key_uq').on(t.key).where(sql`${t.deletedAt} is null`),
    check('workflow_type_ck', sql`${t.type} in ('requirement-validation','regression-testing')`),
    check('workflow_status_ck', sql`${t.status} in ('draft','in_review','published','disabled')`),
  ],
);

export const workflowVersion = pgTable(
  'workflow_version',
  {
    id: id(),
    workflowId: uuid('workflow_id').notNull(),
    version: integer('version').notNull(),
    contentHash: text('content_hash').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
    approvedBy: text('approved_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workflow_version_uq').on(t.workflowId, t.version)],
);

export const workflowExecution = pgTable(
  'workflow_execution',
  {
    id: id(),
    workflowId: uuid('workflow_id').notNull(),
    versionId: uuid('version_id').notNull(),
    status: text('status').notNull().default('queued'),
    stepIndex: integer('step_index').notNull().default(0),
    phase: text('phase').notNull().default('pending'),
    control: text('control'),
    leaseOwner: text('lease_owner'),
    leaseUntil: ts('lease_until'),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('workflow_execution_status_ck', sql`${t.status} in ('queued','running','paused','succeeded','failed','cancelled')`),
    check('workflow_execution_phase_ck', sql`${t.phase} in ('pending','effect')`),
    index('workflow_execution_status_idx').on(t.status),
  ],
);

export const workflowEvent = pgTable('workflow_event', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  executionId: uuid('execution_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  at: ts('at').notNull().defaultNow(),
});

export const workflowEffect = pgTable(
  'workflow_effect',
  {
    executionId: uuid('execution_id').notNull(),
    stepId: text('step_id').notNull(),
    effectKey: text('effect_key').notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.executionId, t.stepId, t.effectKey] })],
);

/* ---------- test cases ---------- */

export const testCase = pgTable(
  'test_case',
  {
    id: id(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull().default(''),
    currentVersion: integer('current_version').notNull().default(1),
    deletedAt: ts('deleted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('test_case_key_uq').on(t.key).where(sql`${t.deletedAt} is null`)],
);

export const testCaseVersion = pgTable(
  'test_case_version',
  {
    id: id(),
    testCaseId: uuid('test_case_id').notNull(),
    version: integer('version').notNull(),
    steps: text('steps').notNull(),
    expected: text('expected').notNull().default(''),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('test_case_version_uq').on(t.testCaseId, t.version)],
);

export const testCollection = pgTable(
  'test_collection',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    deletedAt: ts('deleted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('test_collection_name_uq').on(t.name).where(sql`${t.deletedAt} is null`)],
);

export const testCollectionCase = pgTable(
  'test_collection_case',
  {
    collectionId: uuid('collection_id').notNull(),
    testCaseId: uuid('test_case_id').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.testCaseId] })],
);

/* ---------- governance ---------- */

/** Append-only hash chain. Writers serialise through an advisory lock so seq and prev_hash never fork. */
export const auditLog = pgTable(
  'audit_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    at: text('at').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('audit_log_subject_idx').on(t.subjectType, t.subjectId), index('audit_log_actor_idx').on(t.actorId)],
);

export const egressAllowlist = pgTable(
  'egress_allowlist',
  {
    id: id(),
    hostPattern: text('host_pattern').notNull(),
    purpose: text('purpose').notNull(),
    internal: boolean('internal').notNull().default(false),
    allowHttp: boolean('allow_http').notNull().default(false),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: ts('approved_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('egress_allowlist_host_uq').on(sql`lower(${t.hostPattern})`, t.purpose),
    check('egress_purpose_ck', sql`${t.purpose} in ('connector','application','registry','llm')`),
    check('egress_http_internal_ck', sql`${t.allowHttp} = false or ${t.internal} = true`),
  ],
);

export const platformSetting = pgTable('platform_setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => appUser.id),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
