import type { CapabilityId, ConnectorCategory, PermissionReport, SupportLevel } from '@qa/connector-sdk';

export type ConnectorStatus = 'draft' | 'connected' | 'degraded' | 'error' | 'disconnected';
export type AccessMode = 'read_only' | 'read_write';

export interface ConnectorRecord {
  id: string;
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
  list(): Promise<ConnectorRecord[]>;
  get(id: string): Promise<ConnectorRecord | undefined>;
  /** Throws PlatformError('conflict') when the name is taken for this provider. */
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
