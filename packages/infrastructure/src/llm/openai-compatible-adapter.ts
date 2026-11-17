import { PlatformError } from '@qa/domain';
import type { HttpPort } from '@qa/connector-sdk';
import type { ChatMessage, ChatRequest, ChatResult, HealthStatus, LlmPort, ModelInfo, ToolCall } from '@qa/llm';
import { providerError } from './errors';

export interface OpenAiCompatibleOptions {
  /** Base including the version prefix, e.g. http://vllm:8000/v1 */
  baseUrl: string;
  http: HttpPort;
  /** Resolved from the secret store by the composition root; never logged. */
  apiKey?: string;
  adapterName?: string;
}

type Content = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

/** vLLM, llama.cpp server, LM Studio and anything else speaking the OpenAI chat-completions dialect. */
export class OpenAiCompatibleAdapter implements LlmPort {
  readonly adapter: string;
  private readonly base: string;

  constructor(private readonly o: OpenAiCompatibleOptions) {
    this.adapter = o.adapterName ?? 'openai-compatible';
    this.base = o.baseUrl.replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) };
  }

  private toWire(messages: ChatMessage[]): Record<string, unknown>[] {
    const pending: { id: string; name: string }[] = [];
    let n = 0;
    return messages.map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const calls = m.toolCalls.map((c) => {
          const id = `call_${(n += 1)}`;
          pending.push({ id, name: c.name });
          return { id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } };
        });
        return { role: 'assistant', content: m.content || null, tool_calls: calls };
      }
      if (m.role === 'tool') {
        const i = pending.findIndex((p) => p.name === m.toolName);
        const id = i >= 0 ? pending.splice(i, 1)[0]!.id : `call_${(n += 1)}`;
        return { role: 'tool', tool_call_id: id, content: m.content };
      }
      const content: Content = m.images?.length
        ? [{ type: 'text', text: m.content }, ...m.images.map((b) => ({ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${b}` } }))]
        : m.content;
      return { role: m.role, content };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = {
      model: req.model,
      messages: this.toWire(req.messages),
      temperature: req.temperature,
      max_tokens: req.maxOutputTokens,
      tools: req.tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      response_format: req.jsonSchema ? { type: 'json_schema', json_schema: { name: 'output', schema: req.jsonSchema, strict: true } } : undefined,
    };
    const res = await this.o.http.request({ method: 'POST', url: `${this.base}/chat/completions`, headers: this.headers(), body: JSON.stringify(body), signal: req.signal });
    if (res.status !== 200) throw providerError(res, `${this.adapter} chat`);
    const j = res.json<{
      model?: string;
      choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>();
    const choice = j.choices?.[0];
    if (!choice?.message) throw new PlatformError('transient', `${this.adapter} returned no choices`);
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((c) => {
      if (!c.function?.name) return [];
      let args: Record<string, unknown> = {};
      try {
        const v = JSON.parse(c.function.arguments ?? '{}') as unknown;
        if (v && typeof v === 'object') args = v as Record<string, unknown>;
      } catch {
        args = {};
      }
      return [{ name: c.function.name, arguments: args }];
    });
    const fr = choice.finish_reason;
    return {
      model: j.model ?? req.model,
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : fr === 'length' ? 'length' : fr === 'stop' || !fr ? 'stop' : 'other',
      usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 },
    };
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.o.http.request({ method: 'GET', url: `${this.base}/models`, headers: this.headers(), signal });
    if (res.status !== 200) throw providerError(res, `${this.adapter} model list`);
    const data = res.json<{ data?: { id: string; max_model_len?: number }[] }>().data ?? [];
    return data.map((m) => ({ name: m.id, contextTokens: m.max_model_len, supportsStructuredOutput: true }));
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    const t0 = Date.now();
    try {
      const res = await this.o.http.request({ method: 'GET', url: `${this.base}/models`, headers: this.headers(), signal });
      return { ok: res.status === 200, latencyMs: Date.now() - t0, detail: res.status === 200 ? undefined : `status ${res.status}` };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: e instanceof PlatformError ? e.message : 'unreachable' };
    }
  }
}
