export const DATA_CLASSES = ['story', 'code', 'page', 'screenshot', 'test-data', 'evidence'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export type ProviderKind = 'local' | 'external';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Base64 images for vision-capable models. */
  images?: string[];
  toolCalls?: ToolCall[];
  toolName?: string;
  /** Required on `tool` messages: the class of the data the tool returned. The gateway refuses unclassified tool output. */
  dataClass?: DataClass;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What an adapter receives: already gated, redacted and bounded by the gateway. */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** JSON Schema for constrained decoding where the provider supports it. */
  jsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  contextTokens?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  model: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'length' | 'tool_calls' | 'other';
  usage: Usage;
}

export interface ModelInfo {
  name: string;
  family?: string;
  contextTokens?: number;
  supportsToolCalling?: boolean;
  supportsStructuredOutput?: boolean;
  supportsVision?: boolean;
}

export interface HealthStatus {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/**
 * The only thing a provider adapter implements. Agents never see it: they go through the LlmGateway,
 * which owns policy, data-class gating, redaction, budgets and audit.
 */
export interface LlmPort {
  readonly adapter: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  health(signal?: AbortSignal): Promise<HealthStatus>;
}

export interface ModelRequirements {
  structuredOutput?: boolean;
  toolCalling?: boolean;
  minContextTokens?: number;
  vision?: boolean;
}

export interface ProviderDescriptor {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  /** For external providers: the two-Administrator approval exists. Ignored for local. */
  approved?: boolean;
  /** Local providers default to all classes; external providers default to none. */
  allowedDataClasses: readonly DataClass[];
  /** Concurrent in-flight calls (GPU slots). */
  concurrencySlots: number;
  models: readonly ModelInfo[];
}

export interface ProviderEntry {
  descriptor: ProviderDescriptor;
  port: LlmPort;
}

export interface ProviderRegistry {
  get(id: string): ProviderEntry | undefined;
  list(): ProviderEntry[];
}

export interface ModelTarget {
  providerId: string;
  model: string;
}

export interface Assignment {
  primary: ModelTarget;
  fallback?: ModelTarget;
  /** A fallback may only cross from a local to an external provider when explicitly configured and approved. */
  allowExternalFallback?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AssignmentResolver {
  resolve(agentKey: string): Promise<Assignment | undefined>;
}

/** A piece of content given to the model, tagged with its data class so the gate can decide. */
export interface ContextItem {
  class: DataClass;
  label: string;
  text?: string;
  /** Base64 image data. Only allowed when the class is `screenshot` and the model is vision-capable. */
  imageBase64?: string;
}

export interface LlmCallMeta {
  agentKey: string;
  executionId?: string;
  stepId?: string;
}

export interface PromptInput {
  system: string;
  instruction: string;
  context?: ContextItem[];
  /** Earlier turns of a tool loop. */
  history?: ChatMessage[];
}

export interface LlmAuditEntry {
  at: Date;
  agentKey: string;
  executionId?: string;
  stepId?: string;
  providerId?: string;
  providerKind?: ProviderKind;
  model?: string;
  dataClasses: DataClass[];
  contextItems: number;
  droppedImages?: number;
  outcome: 'success' | 'refused' | 'failed' | 'fallback';
  refusalReason?: string;
  errorClass?: string;
  usage?: Usage;
  durationMs: number;
  /** SHA-256 of the redacted prompt, so a transcript store can be tied to the record without copying content here. */
  promptDigest?: string;
}

export interface LlmAuditSink {
  append(entry: LlmAuditEntry): Promise<void>;
}

export interface StructuredSchema<T> {
  jsonSchema: Record<string, unknown>;
  /** Throws or returns `{ success: false }` style errors via `safeParse`. */
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: string };
}

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  input: StructuredSchema<T>;
}

export interface TextRedactor {
  redact(text: string): string;
}
