import type { ZodType } from 'zod';
import type { SecretLease, SecretMaterial } from '@qa/domain';

export const CONNECTOR_CATEGORIES = [
  'work-item',
  'source-repo',
  'browser-automation',
  'test-management',
  'test-runner',
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

export type Access = 'read' | 'write';
export type CapabilityId = string;
export type ConstraintId = 'scope' | 'browser.origin-allowlist' | 'size.max';

export interface CapabilityDescriptor<I = unknown, O = unknown> {
  id: CapabilityId;
  version: number;
  category: ConnectorCategory;
  access: Access;
  risk: 'low' | 'medium' | 'high';
  input: ZodType<I, any, any>;
  output: ZodType<O, any, any>;
  constraints?: ConstraintId[];
  /** Write capabilities declare how retries are made safe. */
  idempotent?: 'natural' | 'key-required';
}

export type SupportLevel = 'supported' | 'partial' | 'unsupported';

export interface CapabilityProbeEntry {
  capability: CapabilityId;
  support: SupportLevel;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  discovered?: Record<string, unknown>;
}

export interface PermissionReport {
  granted: string[];
  /** Any detected write-class permission. Must be empty for source-repo providers. */
  writePermissionsDetected: string[];
  notes?: string[];
}

export interface AuthMethodDescriptor {
  key: string;
  label: string;
  recommended?: boolean;
  fields: { name: string; label: string; secret: boolean; required: boolean }[];
}

export interface WizardStep {
  key: string;
  title: string;
  fields?: { name: string; label: string; type: 'text' | 'url' | 'select' | 'secret'; lookup?: string; required: boolean }[];
  action?: 'test-connection' | 'probe-capabilities' | 'validate-read-only' | 'review';
}

export interface ConnectorManifest {
  providerKey: string;
  category: ConnectorCategory;
  displayName: string;
  description: string;
  authMethods: AuthMethodDescriptor[];
  capabilities: CapabilityId[];
  requiredPermissions: string[];
  accessModePolicy: 'read_only_enforced' | 'read_write';
  requiresInternet: boolean;
  /** live-capable can be pointed at a real system; fixtures-only has not been checked against one; built-in never leaves the platform. */
  verification?: 'live-capable' | 'fixtures-only' | 'built-in';
  wizard: WizardStep[];
}

export interface CallContext {
  instanceId: string;
  config: Record<string, unknown>;
  scope: ConnectorScope;
  signal?: AbortSignal;
}

export interface ConnectorScope {
  project?: string;
  org?: string;
  repo?: string;
  branch?: string;
}

export interface ConnectorClient {
  testConnection(): Promise<ConnectionTestResult>;
  probeCapabilities(): Promise<CapabilityProbeEntry[]>;
  inspectPermissions(): Promise<PermissionReport>;
  handle(capability: CapabilityDescriptor, input: unknown, ctx: CallContext): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface ConnectorProvider {
  manifest: ConnectorManifest;
  configSchema: ZodType<any, any, any>;
  secretSchema: ZodType<any, any, any>;
  create(config: Record<string, unknown>, secrets: SecretLease | undefined, deps: AdapterDeps): ConnectorClient;
}

export interface AdapterDeps {
  /** The only network path adapters may use. Provided by infrastructure. */
  http: HttpPort;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text(): string;
  json<T = unknown>(): T;
}
export interface HttpPort {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface Actor {
  type: 'step' | 'agent' | 'user';
  id: string;
  executionId?: string;
  stepId?: string;
  /** For `agent` actors: the agent key whose grants apply. */
  agentKey?: string;
  /** For `user` actors: permissions resolved by the application layer. */
  permissions?: readonly string[];
}

export interface InvokeRequest<I = unknown> {
  role?: string;
  connectorInstanceId?: string;
  capability: CapabilityId;
  input: I;
  idempotencyKey?: string;
  actor: Actor;
  signal?: AbortSignal;
}

/** The only runtime path steps and agents receive. */
export interface CapabilityInvoker {
  invoke<O = unknown, I = unknown>(req: InvokeRequest<I>): Promise<O>;
}

export interface ResolvedInstance {
  id: string;
  providerKey: string;
  category: ConnectorCategory;
  enabled: boolean;
  status: 'connected' | 'degraded' | 'error' | 'disconnected' | 'draft';
  accessMode: 'read_only' | 'read_write';
  config: Record<string, unknown>;
  scope: ConnectorScope;
  secretLocator?: string;
  effectiveCapabilities: ReadonlySet<CapabilityId>;
}

export interface AgentGrant {
  capability: CapabilityId;
  constraints?: Record<string, unknown>;
}

export interface ExecutionPolicy {
  /** capability ids or `prefix.*` patterns; merged type-level and workflow-level deny lists. */
  capabilityDeny: readonly string[];
  /** role -> instance snapshot taken at execution start. */
  boundRoles: Readonly<Record<string, string>>;
  agentGrants: Readonly<Record<string, readonly AgentGrant[]>>;
  environmentKind?: 'development' | 'qa' | 'staging' | 'uat' | 'production';
  /** Environment origins browser capabilities may navigate to. */
  allowedOrigins?: readonly string[];
  interactionPolicy?: 'observe-only' | 'observe-and-safe-actions';
}

export interface InstanceResolver {
  getById(id: string): Promise<ResolvedInstance | undefined>;
}

export interface ExecutionPolicyStore {
  get(executionId: string): Promise<ExecutionPolicy | undefined>;
}

export type OperationOutcome = 'ok' | 'denied' | 'error';

export interface OperationLogEntry {
  at: Date;
  executionId?: string;
  stepId?: string;
  actorType: Actor['type'];
  actorId: string;
  connectorInstanceId?: string;
  capability: CapabilityId;
  access?: Access;
  outcome: OperationOutcome;
  denialReason?: string;
  errorClass?: string;
  requestDigest: string;
  idempotencyKey?: string;
  durationMs: number;
}

export interface OperationLogSink {
  append(entry: OperationLogEntry): Promise<void>;
}

export interface Redactor {
  redact<T>(value: T): T;
  register(secret: SecretMaterial): void;
}
