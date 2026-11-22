import { z } from 'zod';
import { PERMISSIONS, ROLES } from '@qa/domain';

export const RoleSchema = z.enum(ROLES);
export const PermissionSchema = z.enum(PERMISSIONS);

export const MePermissionsResponse = z.object({
  userId: z.string(),
  displayName: z.string(),
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
});
export type MePermissionsResponse = z.infer<typeof MePermissionsResponse>;

export const HealthResponse = z.object({ status: z.enum(['ok', 'degraded']), profile: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ErrorResponse = z.object({
  error: z.object({ class: z.string(), message: z.string(), requestId: z.string().optional() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export type Permission = z.infer<typeof PermissionSchema>;
export type Role = z.infer<typeof RoleSchema>;

export const SessionResponse = z.object({ csrfToken: z.string(), expiresAt: z.string() });
export type SessionResponse = z.infer<typeof SessionResponse>;

export const IdentityMappingsResponse = z.object({
  items: z.array(z.object({ idpGroup: z.string(), role: RoleSchema, enabled: z.boolean() })),
});
export type IdentityMappingsResponse = z.infer<typeof IdentityMappingsResponse>;

const Category = z.enum(['work-item', 'source-repo', 'browser-automation', 'test-management', 'test-runner']);
const ConnectorStatusSchema = z.enum(['draft', 'connected', 'degraded', 'error', 'disconnected']);

export const ConnectorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  providerKey: z.string(),
  providerName: z.string(),
  category: Category,
  status: ConnectorStatusSchema,
  enabled: z.boolean(),
  accessMode: z.enum(['read_only', 'read_write']),
  lastSuccessAt: z.string().optional(),
  lastTestedAt: z.string().optional(),
  updatedAt: z.string(),
});
export type ConnectorSummary = z.infer<typeof ConnectorSummarySchema>;

export const ConnectorListResponse = z.object({ items: z.array(ConnectorSummarySchema) });
export type ConnectorListResponse = z.infer<typeof ConnectorListResponse>;

const FieldViewSchema = z.object({ name: z.string(), label: z.string(), type: z.enum(['text', 'url', 'select', 'secret']), required: z.boolean() });

export const ProviderViewSchema = z.object({
  providerKey: z.string(),
  category: Category,
  displayName: z.string(),
  description: z.string(),
  requiresInternet: z.boolean(),
  requiredPermissions: z.array(z.string()),
  configFields: z.array(FieldViewSchema),
  authMethods: z.array(z.object({ key: z.string(), label: z.string(), recommended: z.boolean(), fields: z.array(FieldViewSchema) })),
  capabilities: z.array(z.object({ id: z.string(), access: z.enum(['read', 'write']) })),
  steps: z.array(z.object({ key: z.string(), title: z.string(), action: z.string().optional() })),
  verification: z.enum(['live-capable', 'fixtures-only', 'built-in']).optional(),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;
export const ProviderListResponse = z.object({ items: z.array(ProviderViewSchema) });
export type ProviderListResponse = z.infer<typeof ProviderListResponse>;

export const TestResultSchema = z.object({ ok: z.boolean(), message: z.string(), latencyMs: z.number().optional(), errorClass: z.string().optional() });

export const ConnectorDetailSchema = ConnectorSummarySchema.extend({
  configVersion: z.number(),
  config: z.record(z.unknown()).optional(),
  permissionReport: z.object({ granted: z.array(z.string()), writePermissionsDetected: z.array(z.string()), notes: z.array(z.string()).optional() }).optional(),
  discoveredInfo: z.record(z.unknown()).optional(),
  hasCredentials: z.boolean(),
  capabilities: z.array(
    z.object({ capability: z.string(), access: z.enum(['read', 'write', 'unknown']), support: z.enum(['supported', 'partial', 'unsupported']), reason: z.string().optional(), granted: z.boolean() }),
  ),
  latestTest: z.object({ id: z.string(), status: z.enum(['pending', 'running', 'succeeded', 'failed']), requestedAt: z.string(), finishedAt: z.string().optional(), result: TestResultSchema.optional() }).optional(),
  hostIssues: z.array(
    z.object({ host: z.string(), reason: z.enum(['not-approved', 'http-not-allowed']), suggestion: z.object({ hostPattern: z.string(), internal: z.boolean(), allowHttp: z.boolean() }) }),
  ),
  canEnable: z.boolean(),
  /** Present for source repositories: the checks that keep the connection read-only. */
  readOnlyLayers: z.array(z.object({ id: z.string(), label: z.string(), state: z.enum(['holds', 'blocked', 'unknown']), detail: z.string() })).optional(),
});
export type ConnectorDetail = z.infer<typeof ConnectorDetailSchema>;

export const CreateConnectorRequest = z.object({
  providerKey: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  config: z.record(z.unknown()).optional(),
  secrets: z.record(z.unknown()).optional(),
});
export type CreateConnectorRequest = z.infer<typeof CreateConnectorRequest>;

export const UpdateConnectorRequest = z.object({ name: z.string().min(1).max(200).optional(), config: z.record(z.unknown()).optional() });
export type UpdateConnectorRequest = z.infer<typeof UpdateConnectorRequest>;

export const ReplaceCredentialsRequest = z.object({ secrets: z.record(z.unknown()) });
export type ReplaceCredentialsRequest = z.infer<typeof ReplaceCredentialsRequest>;

export const TestRequestResponse = z.object({ id: z.string(), status: z.enum(['pending', 'running', 'succeeded', 'failed']), requestedAt: z.string() });
export type TestRequestResponse = z.infer<typeof TestRequestResponse>;

export const OperationLogResponse = z.object({
  items: z.array(
    z.object({
      seq: z.number(),
      at: z.string(),
      executionId: z.string().optional(),
      actorType: z.string(),
      actorId: z.string(),
      capability: z.string(),
      access: z.string().optional(),
      outcome: z.string(),
      denialReason: z.string().optional(),
      errorClass: z.string().optional(),
      durationMs: z.number(),
    }),
  ),
  nextBeforeSeq: z.number().optional(),
});
export type OperationLogResponse = z.infer<typeof OperationLogResponse>;

export const ApprovedHostSchema = z.object({ id: z.string(), hostPattern: z.string(), purpose: z.enum(['connector', 'application']).optional(), internal: z.boolean(), allowHttp: z.boolean(), approvedAt: z.string() });
export const ApprovedHostListResponse = z.object({ items: z.array(ApprovedHostSchema) });
export type ApprovedHostListResponse = z.infer<typeof ApprovedHostListResponse>;
export const ApproveHostRequest = z.object({ hostPattern: z.string().min(1).max(253), purpose: z.enum(['connector', 'application']).optional(), internal: z.boolean(), allowHttp: z.boolean() });
export type ApproveHostRequest = z.infer<typeof ApproveHostRequest>;
export type { ZodType } from 'zod';

export const LogoutResponse = z.object({ loggedOut: z.boolean(), logoutUrl: z.string().nullable() });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const LlmProvidersResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['local', 'external']),
      adapter: z.string(),
      enabled: z.boolean(),
      health: z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string().optional() }),
      models: z.array(
        z.object({
          name: z.string(),
          contextTokens: z.number().optional(),
          supportsToolCalling: z.boolean().optional(),
          supportsStructuredOutput: z.boolean().optional(),
          supportsVision: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
export type LlmProvidersResponse = z.infer<typeof LlmProvidersResponse>;

const EnvironmentKindSchema = z.enum(['development', 'qa', 'staging', 'uat', 'production']);
const EnvironmentBrowserSchema = z.object({
  browser: z.enum(['chromium', 'firefox', 'webkit']),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  headless: z.boolean(),
  locale: z.string().optional(),
});
const EnvironmentRestrictionsSchema = z.object({
  workflowTypes: z.array(z.enum(['requirement-validation', 'regression-testing'])).optional(),
  maxParallelism: z.number(),
  prodSafeOnly: z.boolean(),
});

export const EnvironmentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: EnvironmentKindSchema,
  applicationUrl: z.string(),
  enabled: z.boolean(),
  selectable: z.boolean(),
  authorizationUntil: z.string().optional(),
});
export const EnvironmentDetailSchema = EnvironmentSummarySchema.extend({
  browser: EnvironmentBrowserSchema,
  restrictions: EnvironmentRestrictionsSchema,
  reachability: z.enum(['not-run', 'queued', 'checking', 'reachable', 'unreachable']),
  reachabilityDetail: z.string().optional(),
  reachabilityCheckedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const EnvironmentListResponse = z.object({ items: z.array(EnvironmentSummarySchema) });
export const CreateEnvironmentRequest = z.object({
  name: z.string(),
  kind: EnvironmentKindSchema,
  applicationUrl: z.string(),
  browser: EnvironmentBrowserSchema.partial().optional(),
  restrictions: EnvironmentRestrictionsSchema.partial().optional(),
  enabled: z.boolean().optional(),
});
export const UpdateEnvironmentRequest = CreateEnvironmentRequest.partial();
export type EnvironmentDetail = z.infer<typeof EnvironmentDetailSchema>;

const AuthType = z.enum(['none', 'basic', 'form-login', 'bearer', 'storage-state']);
const ConnectorRole = z.enum(['work-item', 'source-repo', 'test-management', 'browser-automation']);
const stringMap = z.record(z.string());

export const AuthProfileSchema = z.object({ id: z.string(), name: z.string(), type: AuthType, config: stringMap, hasSecret: z.boolean() });
export const AuthProfileListResponse = z.object({ items: z.array(AuthProfileSchema) });
export const AuthProfileRequest = z.object({ name: z.string(), type: AuthType, config: stringMap.optional(), secrets: stringMap.optional() });
export const TestDataProfileSchema = z.object({ id: z.string(), name: z.string(), data: stringMap, hasSecret: z.boolean() });
export const TestDataListResponse = z.object({ items: z.array(TestDataProfileSchema) });
export const TestDataRequest = z.object({ name: z.string(), data: stringMap.optional(), secrets: stringMap.optional() });
export const ConnectorRefSchema = z.object({ environmentId: z.string(), role: ConnectorRole, connectorInstanceId: z.string(), connectorName: z.string() });
export const ConnectorRefListResponse = z.object({ items: z.array(ConnectorRefSchema) });
export const SetConnectorRefRequest = z.object({ role: ConnectorRole, connectorId: z.string() });
export const AuthorizationSchema = z.object({
  id: z.string(),
  status: z.enum(['active', 'revoked', 'expired']),
  validFrom: z.string(),
  validUntil: z.string(),
  justification: z.string(),
  grantedByName: z.string(),
  active: z.boolean(),
});
export const AuthorizationListResponse = z.object({ items: z.array(AuthorizationSchema) });
export const GrantAuthorizationRequest = z.object({ justification: z.string(), validFrom: z.string(), validUntil: z.string() });
export const EnvironmentValidationSchema = z.object({
  ok: z.boolean(),
  selectable: z.boolean(),
  connectivity: z.literal('not-run'),
  errors: z.array(z.object({ message: z.string() })),
});
export const ResolvedEnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: EnvironmentKindSchema,
  applicationUrl: z.string(),
  browser: EnvironmentBrowserSchema,
  restrictions: EnvironmentRestrictionsSchema,
  selectable: z.boolean(),
  authorizationUntil: z.string().optional(),
  authProfiles: z.array(AuthProfileSchema),
  testDataProfiles: z.array(TestDataProfileSchema),
  connectors: z.array(z.object({ role: ConnectorRole, connectorId: z.string(), name: z.string() })),
  connectivity: z.literal('not-run'),
});
export const WorkflowSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(['requirement-validation', 'regression-testing']),
  status: z.enum(['draft', 'in_review', 'published', 'disabled']),
  enabled: z.boolean(),
  updatedAt: z.string(),
  publishedVersion: z.number().nullable(),
});
export const WorkflowListResponse = z.object({ items: z.array(WorkflowSchema) });
export const CreateWorkflowRequest = z.object({ name: z.string(), type: z.enum(['requirement-validation', 'regression-testing']), description: z.string().optional(), key: z.string().optional(), templateKey: z.string().optional() });
export const UpdateWorkflowRequest = z.object({ name: z.string().optional(), description: z.string().optional() });
export const WorkflowDefinitionResponse = z.object({ definition: z.unknown() });
export const SaveWorkflowDefinitionRequest = z.object({ definition: z.record(z.unknown()) });
export const WorkflowTemplateList = z.object({ items: z.array(z.object({ key: z.string(), name: z.string(), type: z.enum(['requirement-validation', 'regression-testing']), summary: z.string() })) });
export const ValidationIssueSchema = z.object({ ruleId: z.string(), severity: z.enum(['error', 'warning']), path: z.string(), message: z.string(), fixHint: z.string() });
export const ValidationReportSchema = z.object({ issues: z.array(ValidationIssueSchema) });
export const ExecutionSchema = z.object({ id: z.string(), workflowId: z.string(), workflowName: z.string(), status: z.enum(['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled']), stepIndex: z.number(), createdAt: z.string(), updatedAt: z.string() });
export const ExecutionListResponse = z.object({ items: z.array(ExecutionSchema) });
export const StartRunRequest = z.object({ parameters: z.record(z.unknown()).optional() });
export const ExecutionEventSchema = z.object({ seq: z.number(), kind: z.string(), at: z.string(), payload: z.record(z.unknown()) });
export const ExecutionEventList = z.object({ items: z.array(ExecutionEventSchema) });

export const TestCaseKindSchema = z.enum(['positive', 'negative', 'edge']);
export const TestCasePrioritySchema = z.enum(['high', 'medium', 'low']);
export const TestCaseListItemSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  summary: z.string(),
  workItem: z.string(),
  kind: TestCaseKindSchema,
  priority: TestCasePrioritySchema,
  version: z.number(),
  updatedAt: z.string(),
});
export const TestCaseListResponse = z.object({ items: z.array(TestCaseListItemSchema) });
export const TestCaseSchema = TestCaseListItemSchema.extend({ steps: z.string(), expected: z.string() });
export const CreateTestCaseRequest = z.object({
  name: z.string(),
  summary: z.string().optional(),
  steps: z.string(),
  expected: z.string(),
  workItem: z.string().optional(),
  kind: TestCaseKindSchema.optional(),
  priority: TestCasePrioritySchema.optional(),
});
export const ReviseTestCaseRequest = z.object({ summary: z.string().optional(), steps: z.string(), expected: z.string() });
export const TestCaseVersionSchema = z.object({ version: z.number(), steps: z.string(), expected: z.string(), createdAt: z.string() });
export const TestCaseVersionList = z.object({ items: z.array(TestCaseVersionSchema) });
export const TestCollectionListItemSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), size: z.number() });
export const TestCollectionListResponse = z.object({ items: z.array(TestCollectionListItemSchema) });
export const TestCollectionCaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  position: z.number(),
  kind: TestCaseKindSchema,
  priority: TestCasePrioritySchema,
});
export const TestCollectionSchema = z.object({ id: z.string(), name: z.string(), description: z.string(), cases: z.array(TestCollectionCaseSchema) });
export const CreateTestCollectionRequest = z.object({ name: z.string(), description: z.string().optional() });
export const AddCollectionCaseRequest = z.object({ testCaseId: z.string() });
export const ResetTestCasesRequest = z.object({
  confirm: z.literal('RESET_PLATFORM_CASES'),
  /** Reserved: Squash is never wiped by this endpoint. Keep false / omit. */
  wipeSquash: z.boolean().optional(),
});
export const ResetTestCasesResponse = z.object({
  collectionsCleared: z.number(),
  casesCleared: z.number(),
  squashWiped: z.literal(false),
});
export const WorkItemCaseStatus = z.enum(['Queued', 'Running', 'Passed', 'Failed', 'Blocked', 'Skipped']);
export const WorkItemCaseStepSchema = z.object({
  name: z.string(),
  status: z.enum(['Queued', 'Running', 'Passed', 'Failed', 'Blocked', 'Skipped']),
});
export const WorkItemCaseResultSchema = z.object({
  id: z.string(),
  testCaseId: z.string(),
  name: z.string(),
  status: WorkItemCaseStatus,
  message: z.string(),
  hasScreenshot: z.boolean(),
  squashExecutionId: z.string().optional(),
  steps: z.array(WorkItemCaseStepSchema).optional(),
});
export const WorkItemRunCounts = z.object({
  total: z.number(),
  queued: z.number(),
  running: z.number(),
  passed: z.number(),
  failed: z.number(),
  blocked: z.number(),
  skipped: z.number(),
  completed: z.number(),
});
export const WorkItemExecutionSchema = z.object({
  id: z.string(),
  workItem: z.string(),
  environmentId: z.string(),
  environmentName: z.string(),
  caseCount: z.number(),
  status: z.enum(['prepared', 'queued', 'running', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  squashSync: z.string().optional(),
  counts: WorkItemRunCounts.optional(),
  results: z.array(WorkItemCaseResultSchema).optional(),
});
export const WorkItemExecutionBoard = z.object({
  workItems: z.array(z.object({ workItem: z.string(), caseCount: z.number() })),
  environments: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string() })),
  items: z.array(WorkItemExecutionSchema),
});
export const StartWorkItemExecutionRequest = z.object({ workItem: z.string(), environmentId: z.string() });
export const WorkItemCaseScreenshot = z.object({
  testCaseId: z.string(),
  name: z.string(),
  contentType: z.enum(['image/png', 'image/jpeg']),
  pngBase64: z.string().min(200),
});

export const ValidateEnvironmentRequest = z.object({
  workflowType: z.enum(['requirement-validation', 'regression-testing']).optional(),
  parallelism: z.number().optional(),
  prodSafe: z.boolean().optional(),
});
