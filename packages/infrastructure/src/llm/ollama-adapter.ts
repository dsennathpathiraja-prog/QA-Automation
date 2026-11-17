import { PlatformError } from '@qa/domain';
import type { HttpPort } from '@qa/connector-sdk';
import type { ChatMessage, ChatRequest, ChatResult, HealthStatus, LlmPort, ModelInfo, ToolCall } from '@qa/llm';
import { providerError } from './errors';

export interface OllamaOptions {
  baseUrl: string;
  http: HttpPort;
  /** How long Ollama keeps the model loaded after a call (avoids reloading on every step). */
  keepAlive?: string;
}

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

const toOllama = (m: ChatMessage): OllamaMessage => ({
  role: m.role,
  content: m.content,
  images: m.images,
  tool_calls: m.toolCalls?.map((c) => ({ function: { name: c.name, arguments: c.arguments } })),
  tool_name: m.role === 'tool' ? m.toolName : undefined,
});

export class OllamaAdapter implements LlmPort {
  readonly adapter = 'ollama';
  private readonly base: string;

  constructor(private readonly o: OllamaOptions) {
    this.base = o.baseUrl.replace(/\/$/, '');
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = {
      model: req.model,
      messages: req.messages.map(toOllama),
      stream: false,
      format: req.jsonSchema,
      tools: req.tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      options: { temperature: req.temperature, num_predict: req.maxOutputTokens, num_ctx: req.contextTokens },
      keep_alive: this.o.keepAlive,
    };
    const res = await this.o.http.request({
      method: 'POST',
      url: `${this.base}/api/chat`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (res.status !== 200) throw providerError(res, 'Ollama chat');
    const j = res.json<{
      model?: string;
      message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    }>();
    if (!j.message) throw new PlatformError('transient', 'Ollama returned no message');
    const toolCalls: ToolCall[] = (j.message.tool_calls ?? []).flatMap((c) => {
      const name = c.function?.name;
      if (!name) return [];
      const a = c.function?.arguments;
      return [{ name, arguments: a && typeof a === 'object' ? (a as Record<string, unknown>) : parseArgs(a) }];
    });
    return {
      model: j.model ?? req.model,
      content: j.message.content ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : j.done_reason === 'length' ? 'length' : j.done_reason === 'stop' || !j.done_reason ? 'stop' : 'other',
      usage: { inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 },
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.o.http.request({ method: 'GET', url: `${this.base}/api/tags`, signal });
    if (res.status !== 200) throw providerError(res, 'Ollama model list');
    const tags = res.json<{ models?: { name: string; details?: { family?: string } }[] }>().models ?? [];
    return Promise.all(tags.map((t) => this.describe(t.name, t.details?.family, signal)));
  }

  private async describe(name: string, family: string | undefined, signal?: AbortSignal): Promise<ModelInfo> {
    const base: ModelInfo = { name, family, supportsStructuredOutput: true };
    try {
      const res = await this.o.http.request({
        method: 'POST',
        url: `${this.base}/api/show`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal,
      });
      if (res.status !== 200) return base;
      const j = res.json<{ capabilities?: string[]; model_info?: Record<string, unknown> }>();
      const ctxKey = Object.keys(j.model_info ?? {}).find((k) => k.endsWith('.context_length'));
      const ctx = ctxKey ? Number(j.model_info![ctxKey]) : undefined;
      return {
        ...base,
        contextTokens: ctx && Number.isFinite(ctx) ? ctx : undefined,
        supportsToolCalling: j.capabilities?.includes('tools'),
        supportsVision: j.capabilities?.includes('vision'),
      };
    } catch {
      return base;
    }
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      const res = await this.o.http.request({ method: 'GET', url: `${this.base}/api/tags`, signal });
      return { ok: res.status === 200, latencyMs: Date.now() - t0, detail: res.status === 200 ? undefined : `status ${res.status}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: e instanceof PlatformError ? e.message : 'unreachable' };
    }
  }
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (typeof a !== 'string') return {};
  try {
    const v = JSON.parse(a) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
