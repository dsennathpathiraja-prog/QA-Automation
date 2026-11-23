import type { CapabilityId, ConnectorCategory, PermissionReport, SupportLevel } from '@qa/connector-sdk';

export type ConnectorStatus = 'draft' | 'connected' | 'degraded' | 'error' | 'disconnected';
export type AccessMode = 'read_only' | 'read_write';

export interface ConnectorRecord {
  id: string;
  projectId: string;
  providerKey: string;
  category: ConnectorCategory;
  name: string;
  status: ConnectorStatus;
  enabled: boolean;
  accessMode: AccessMode;
  /** Non-secret settings only. */
  config: Record<string, unknown>;
  permissionReport?: PermissionReport;
  discoveredInfo?: Record<string, unknown>;
  configVersion: number;
  lastSuccessAt?: Date;
  lastTestedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewConnector {
  id: string;
  projectId: string;
  providerKey: string;
  category: ConnectorCategory;
  name: string;
  config: Record<string, unknown>;
  accessMode: AccessMode;
}

export interface ConnectorPatch {
  name?: string;
  config?: Record<string, unknown>;
  status?: ConnectorStatus;
  enabled?: boolean;
  configVersion?: number;
  permissionReport?: PermissionReport | null;
  discoveredInfo?: Record<string, unknown> | null;
  lastSuccessAt?: Date;
  lastTestedAt?: Date;
}

export interface CapabilityStateRecord {
  capability: CapabilityId;
  support: SupportLevel;
  reason?: string;
  /** Declared, probed as available and permitted. Only granted capabilities are usable. */
  granted: boolean;
}

export interface ConnectorRepository {
  list(filter?: { projectId?: string }): Promise<ConnectorRecord[]>;
  get(id: string): Promise<ConnectorRecord | undefined>;
  /** Throws PlatformError('conflict') when the name is taken for this provider in the project. */
  insert(rec: NewConnector): Promise<ConnectorRecord>;
  update(id: string, patch: ConnectorPatch): Promise<ConnectorRecord>;
  softDelete(id: string): Promise<void>;
  capabilityStates(id: string): Promise<CapabilityStateRecord[]>;
  replaceCapabilityStates(id: string, states: CapabilityStateRecord[]): Promise<void>;
  recordHealth(id: string, h: { result: 'ok' | 'warn' | 'fail'; detail?: Record<string, unknown>; latencyMs?: number }): Promise<void>;
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  errorClass?: string;
}

export type TestRequestStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface TestRequestRecord {
  id: string;
  connectorId: string;
  configVersion: number;
  status: TestRequestStatus;
  requestedBy: string;
  requestedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  result?: TestResult;
}

export interface TestRequestQueue {
  /** Returns the open (pending or running) request for the connector instead of queueing a second one. */
  enqueue(connectorId: string, configVersion: number, requestedBy: string): Promise<TestRequestRecord>;
  latest(connectorId: string): Promise<TestRequestRecord | undefined>;
  /** Atomically moves one pending request to running. Safe with several workers. */
  claimNext(): Promise<TestRequestRecord | undefined>;
  finish(id: string, status: 'succeeded' | 'failed', result: TestResult): Promise<void>;
  /** Fails requests stuck in running since before `before` (a worker died mid-test). */
  failStale(before: Date): Promise<number>;
}

export interface AuditSink {
  append(e: { actorId: string; action: string; subjectType: string; subjectId?: string; detail?: Record<string, unknown> }): Promise<unknown>;
}

export interface ApprovedHost {
  id: string;
  hostPattern: string;
  purpose: 'connector' | 'application' | 'registry' | 'llm';
  internal: boolean;
  allowHttp: boolean;
  approvedAt: Date;
}

export interface ApprovedHostRepository {
  list(purpose?: ApprovedHost['purpose']): Promise<ApprovedHost[]>;
  /** Throws PlatformError('conflict') for a duplicate. */
  add(h: { hostPattern: string; purpose: ApprovedHost['purpose']; internal: boolean; allowHttp: boolean; approvedBy?: string }): Promise<ApprovedHost>;
  remove(id: string): Promise<ApprovedHost | undefined>;
}

export interface OperationLogRow {
  seq: number;
  at: Date;
  executionId?: string;
  actorType: string;
  actorId: string;
  connectorInstanceId?: string;
  capability: string;
  access?: string;
  outcome: string;
  denialReason?: string;
  errorClass?: string;
  durationMs: number;
}

export interface OperationLogReader {
  list(f: { connectorInstanceId?: string; outcome?: string; capability?: string; beforeSeq?: number; limit: number }): Promise<OperationLogRow[]>;
}

export const connectorSecretLocator = (connectorId: string) => `connectors/${connectorId}/credentials`;

export const ENVIRONMENT_KINDS = ['development', 'qa', 'staging', 'uat', 'production'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export interface EnvironmentBrowser {
  browser: 'chromium' | 'firefox' | 'webkit';
  viewport?: { width: number; height: number };
  headless: boolean;
  locale?: string;
}

export interface EnvironmentRestrictions {
  workflowTypes?: ('requirement-validation' | 'regression-testing')[];
  maxParallelism: number;
  prodSafeOnly: boolean;
}

export const REACHABILITY = ['not-run', 'queued', 'checking', 'reachable', 'unreachable'] as const;
export type Reachability = (typeof REACHABILITY)[number];

export interface EnvironmentRecord {
  id: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
  applicationUrl: string;
  /**
   * Optional notification/email template preview URL for stories that validate
   * escrow/email templates (Phase 8 E2). When unset, Explore fails closed on shop-only hosts.
   */
  templatePreviewUrl?: string;
  browser: EnvironmentBrowser;
  restrictions: EnvironmentRestrictions;
  enabled: boolean;
  /** Whether the application address answered the last check. */
  reachability: Reachability;
  reachabilityDetail?: string;
  reachabilityCheckedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewEnvironment {
  id: string;
  projectId: string;
  name: string;
  kind: EnvironmentKind;
  applicationUrl: string;
  templatePreviewUrl?: string;
  browser: EnvironmentBrowser;
  restrictions: EnvironmentRestrictions;
  enabled: boolean;
  createdBy?: string;
}

export interface EnvironmentPatch {
  name?: string;
  kind?: EnvironmentKind;
  applicationUrl?: string;
  /** Pass empty string to clear. */
  templatePreviewUrl?: string | null;
  browser?: EnvironmentBrowser;
  restrictions?: EnvironmentRestrictions;
  enabled?: boolean;
}

export interface EnvironmentAuthorizationRecord {
  id: string;
  environmentId: string;
  status: 'active' | 'revoked' | 'expired';
  validFrom: Date;
  validUntil: Date;
  justification?: string;
  grantedByName?: string;
}

export const AUTH_PROFILE_TYPES = ['none', 'basic', 'form-login', 'bearer', 'storage-state'] as const;
export type AuthProfileType = (typeof AUTH_PROFILE_TYPES)[number];

export const CONNECTOR_ROLES = ['work-item', 'source-repo', 'test-management', 'browser-automation'] as const;
export type ConnectorRole = (typeof CONNECTOR_ROLES)[number];

export interface AuthProfileRecord {
  id: string;
  environmentId: string;
  name: string;
  type: AuthProfileType;
  /** Non-secret fields only, such as a login address or username. */
  config: Record<string, string>;
  hasSecret: boolean;
  secretLocator?: string;
}

export interface TestDataRecord {
  id: string;
  environmentId: string;
  name: string;
  data: Record<string, string>;
  hasSecret: boolean;
  secretLocator?: string;
}

export interface ConnectorRefRecord {
  environmentId: string;
  role: ConnectorRole;
  connectorInstanceId: string;
  connectorName: string;
}

export interface NewAuthorization {
  id: string;
  environmentId: string;
  grantedBy: string;
  grantedByName: string;
  justification: string;
  validFrom: Date;
  validUntil: Date;
}

export interface SecretRefWrite {
  id: string;
  store: 'openbao' | 'db-envelope';
  locator: string;
  version: number;
  ownerType: 'auth_profile' | 'test_data_profile';
  ownerId: string;
}

export interface UserDirectory {
  findBySubject(subject: string): Promise<{ id: string; displayName: string } | undefined>;
}

export interface ConnectorLookup {
  get(id: string): Promise<{ id: string; name: string; category: string; enabled: boolean } | undefined>;
}

export interface EnvironmentRepository {
  list(filter?: { projectId?: string }): Promise<EnvironmentRecord[]>;
  get(id: string): Promise<EnvironmentRecord | undefined>;
  /** Throws PlatformError('conflict') when the name is taken in the project. */
  insert(rec: NewEnvironment): Promise<EnvironmentRecord>;
  update(id: string, patch: EnvironmentPatch): Promise<EnvironmentRecord>;
  softDelete(id: string): Promise<void>;
  activeAuthorization(environmentId: string, at: Date): Promise<EnvironmentAuthorizationRecord | undefined>;
  listAuthProfiles(environmentId: string): Promise<AuthProfileRecord[]>;
  insertAuthProfile(rec: AuthProfileRecord): Promise<AuthProfileRecord>;
  updateAuthProfile(id: string, patch: Partial<Pick<AuthProfileRecord, 'name' | 'type' | 'config' | 'hasSecret' | 'secretLocator'>>): Promise<AuthProfileRecord>;
  deleteAuthProfile(id: string): Promise<void>;
  listTestData(environmentId: string): Promise<TestDataRecord[]>;
  insertTestData(rec: TestDataRecord): Promise<TestDataRecord>;
  updateTestData(id: string, patch: Partial<Pick<TestDataRecord, 'name' | 'data' | 'hasSecret' | 'secretLocator'>>): Promise<TestDataRecord>;
  deleteTestData(id: string): Promise<void>;
  listConnectorRefs(environmentId: string): Promise<ConnectorRefRecord[]>;
  upsertConnectorRef(rec: ConnectorRefRecord): Promise<void>;
  deleteConnectorRef(environmentId: string, role: ConnectorRole): Promise<void>;
  listAuthorizations(environmentId: string): Promise<EnvironmentAuthorizationRecord[]>;
  insertAuthorization(rec: NewAuthorization): Promise<EnvironmentAuthorizationRecord>;
  revokeAuthorization(id: string, environmentId: string): Promise<EnvironmentAuthorizationRecord | undefined>;
  saveSecretRef(rec: SecretRefWrite): Promise<void>;
  deleteSecretRef(ownerType: SecretRefWrite['ownerType'], ownerId: string): Promise<void>;
  /** Marks a check as waiting. A check that is already queued or running is left as it is. */
  queueReachability(id: string): Promise<EnvironmentRecord>;
  /** Takes one queued check and marks it running. Undefined when nothing is waiting. */
  claimReachability(): Promise<EnvironmentRecord | undefined>;
  finishReachability(id: string, result: 'reachable' | 'unreachable', detail: string, at: Date): Promise<void>;
  /** Drops a previous result, used when the application address changes. */
  clearReachability(id: string): Promise<void>;
}

/* ---------- projects ---------- */

export type ProjectStatus = 'active' | 'archived';

export interface ProjectRecord {
  id: string;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProject {
  id: string;
  key: string;
  name: string;
  description: string;
  createdBy?: string;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  status?: ProjectStatus;
}

export interface ProjectRepository {
  list(filter?: { status?: ProjectStatus }): Promise<ProjectRecord[]>;
  get(id: string): Promise<ProjectRecord | undefined>;
  getByKey(key: string): Promise<ProjectRecord | undefined>;
  /** Throws PlatformError('conflict') when key or name is taken. */
  insert(rec: NewProject): Promise<ProjectRecord>;
  update(id: string, patch: ProjectPatch): Promise<ProjectRecord>;
  softDelete(id: string): Promise<void>;
}
