import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmGateway, StaticAssignmentResolver, StaticProviderRegistry, fromZod, type LlmAuditEntry } from '@qa/llm';
import { EgressPolicy, HardenedHttpClient, OllamaAdapter, OpenAiCompatibleAdapter } from '../src';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | undefined;
}

/** Minimal stand-in for both Ollama's and an OpenAI-compatible server's HTTP surface. */
function fakeServer(handler: (seen: Seen, res: ServerResponse) => void): Promise<{ server: Server; url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined };
      seen.push(s);
      handler(s, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })));
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const http = () =>
  new HardenedHttpClient({
    egress: new EgressPolicy({ rules: [{ hostPattern: '127.0.0.1', purpose: 'llm', internal: true, allowHttp: true, allowLoopback: true }], profile: 'standard', platformEnv: 'test' }),
    allowedMethods: ['GET', 'POST'],
    timeoutMs: 5_000,
  });

describe('OllamaAdapter (over the hardened HTTP client)', () => {
  let srv: Awaited<ReturnType<typeof fakeServer>>;
  let mode: 'ok' | 'tools' | 'missing' | 'busy' | 'down' = 'ok';
  beforeAll(async () => {
    srv = await fakeServer((s, res) => {
      if (s.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen2.5:7b', details: { family: 'qwen2' } }, { name: 'llava:7b', details: { family: 'llama' } }] });
      if (s.url === '/api/show') {
        const m = (s.body as { model: string }).model;
        return json(res, 200, m.startsWith('llava') ? { capabilities: ['completion', 'vision'], model_info: { 'llama.context_length': 4096 } } : { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } });
      }
      if (s.url === '/api/chat') {
        if (mode === 'missing') return json(res, 404, { error: "model 'nope' not found" });
        if (mode === 'busy') return json(res, 429, { error: 'too many' });
        if (mode === 'down') return json(res, 503, {});
        if (mode === 'tools') return json(res, 200, { model: 'qwen2.5:7b', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'browser.click', arguments: { ref: 'e5' } } }] }, done_reason: 'stop', prompt_eval_count: 30, eval_count: 8 });
        return json(res, 200, { model: 'qwen2.5:7b', message: { role: 'assistant', content: '{"title":"T","cases":["a"]}' }, done_reason: 'stop', prompt_eval_count: 12, eval_count: 7 });
      }
      json(res, 404, {});
    });
  });
  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  const adapter = () => new OllamaAdapter({ baseUrl: srv.url, http: http(), keepAlive: '10m' });

  it('maps a chat request (schema as `format`, options, keep_alive) and the response', async () => {
    mode = 'ok';
    const r = await adapter().chat({
      model: 'qwen2.5:7b', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u', images: ['AAAA'] }],
      jsonSchema: { type: 'object' }, temperature: 0.2, maxOutputTokens: 256, contextTokens: 8192,
    });
    expect(r).toMatchObject({ content: '{"title":"T","cases":["a"]}', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 7 } });
    const sent = srv.seen.filter((s) => s.url === '/api/chat').at(-1)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'qwen2.5:7b', stream: false, format: { type: 'object' }, keep_alive: '10m', options: { temperature: 0.2, num_predict: 256, num_ctx: 8192 } });
    expect((sent.messages as { images?: string[] }[])[1]!.images).toEqual(['AAAA']);
  });

  it('parses tool calls and sends tool specs', async () => {
    mode = 'tools';
    const r = await adapter().chat({ model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'browser.click', description: 'Click', parameters: { type: 'object' } }] });
    expect(r.toolCalls).toEqual([{ name: 'browser.click', arguments: { ref: 'e5' } }]);
    expect(r.finishReason).toBe('tool_calls');
    const sent = srv.seen.filter((s) => s.url === '/api/chat').at(-1)!.body as { tools: { type: string; function: { name: string } }[] };
    expect(sent.tools[0]).toMatchObject({ type: 'function', function: { name: 'browser.click' } });
  });

  it('lists models with capabilities and context length from /api/show', async () => {
    const models = await adapter().listModels();
    expect(models).toEqual([
      { name: 'qwen2.5:7b', family: 'qwen2', supportsStructuredOutput: true, contextTokens: 32768, supportsToolCalling: true, supportsVision: false },
      { name: 'llava:7b', family: 'llama', supportsStructuredOutput: true, contextTokens: 4096, supportsToolCalling: false, supportsVision: true },
    ]);
  });

  it('maps failures to the error taxonomy and reports health without throwing', async () => {
    mode = 'missing';
    await expect(adapter().chat({ model: 'nope', messages: [] })).rejects.toMatchObject({ errorClass: 'not-found', details: { unavailable: true } });
    mode = 'busy';
    await expect(adapter().chat({ model: 'x', messages: [] })).rejects.toMatchObject({ errorClass: 'rate-limited', retryable: true });
    mode = 'down';
    await expect(adapter().chat({ model: 'x', messages: [] })).rejects.toMatchObject({ errorClass: 'transient', retryable: true });
    expect(await adapter().health()).toMatchObject({ ok: true });
    const dead = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:1', http: http() });
    expect(await dead.health()).toMatchObject({ ok: false });
  });

  it('works end to end through the gateway (structured output, audit, redaction)', async () => {
    mode = 'ok';
    const a = adapter();
    const audit: LlmAuditEntry[] = [];
    const gw = new LlmGateway({
      registry: new StaticProviderRegistry([{ descriptor: { id: 'ollama', kind: 'local', enabled: true, allowedDataClasses: ['story', 'code', 'page', 'screenshot', 'test-data', 'evidence'], concurrencySlots: 1, models: await a.listModels() }, port: a }]),
      assignments: new StaticAssignmentResolver({ planner: { primary: { providerId: 'ollama', model: 'qwen2.5:7b' } } }),
      redactor: { redact: (s) => s.replaceAll('TOKEN-123', '[REDACTED]') },
      audit: { append: async (e) => void audit.push(e) },
      profile: 'airgapped',
    });
    const r = await gw.generateStructured({ agentKey: 'planner' }, { system: 'plan', instruction: 'go', context: [{ class: 'story', label: 's', text: 'use TOKEN-123' }] }, fromZod(z.object({ title: z.string(), cases: z.array(z.string()) })));
    expect(r.data).toEqual({ title: 'T', cases: ['a'] });
    const chat = srv.seen.filter((s) => s.url === '/api/chat').at(-1)!;
    expect(JSON.stringify(chat.body)).not.toContain('TOKEN-123');
    expect(audit[0]).toMatchObject({ outcome: 'success', providerKind: 'local' });
  });
});

describe('OpenAiCompatibleAdapter (vLLM and friends)', () => {
  let srv: Awaited<ReturnType<typeof fakeServer>>;
  beforeAll(async () => {
    srv = await fakeServer((s, res) => {
      if (s.url === '/v1/models') return json(res, 200, { data: [{ id: 'Qwen/Qwen2.5-7B-Instruct', max_model_len: 16384 }] });
      if (s.url === '/v1/chat/completions') {
        const wantsTools = Array.isArray((s.body as { tools?: unknown[] }).tools);
        const msg = wantsTools
          ? { content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'browser.click', arguments: '{"ref":"e9"}' } }] }
          : { content: '{"ok":true}' };
        return json(res, 200, { model: 'Qwen/Qwen2.5-7B-Instruct', choices: [{ message: msg, finish_reason: wantsTools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
      }
      json(res, 404, {});
    });
  });
  afterAll(() => new Promise<void>((r) => srv.server.close(() => r())));

  const adapter = (apiKey?: string) => new OpenAiCompatibleAdapter({ baseUrl: `${srv.url}/v1`, http: http(), apiKey, adapterName: 'vllm' });

  it('maps JSON schema to response_format, sends the key as a bearer token, and parses usage', async () => {
    const r = await adapter('k-123').chat({ model: 'Qwen/Qwen2.5-7B-Instruct', messages: [{ role: 'user', content: 'hi', images: ['AAAA'] }], jsonSchema: { type: 'object' }, maxOutputTokens: 64 });
    expect(r).toMatchObject({ content: '{"ok":true}', usage: { inputTokens: 20, outputTokens: 4 } });
    const s = srv.seen.filter((x) => x.url === '/v1/chat/completions').at(-1)!;
    expect(s.headers.authorization).toBe('Bearer k-123');
    expect(s.body).toMatchObject({ max_tokens: 64, response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' }, strict: true } } });
    expect((s.body!.messages as { content: { type: string }[] }[])[0]!.content.map((c) => c.type)).toEqual(['text', 'image_url']);
  });

  it('parses string-encoded tool arguments and pairs tool results with the calls that produced them', async () => {
    const a = adapter();
    const r = await a.chat({
      model: 'm',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ name: 'browser.click', arguments: { ref: 'e1' } }] },
        { role: 'tool', content: 'clicked', toolName: 'browser.click' },
      ],
      tools: [{ name: 'browser.click', description: 'Click', parameters: { type: 'object' } }],
    });
    expect(r.toolCalls).toEqual([{ name: 'browser.click', arguments: { ref: 'e9' } }]);
    const wire = srv.seen.filter((x) => x.url === '/v1/chat/completions').at(-1)!.body!.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    expect(wire[2]!.tool_call_id).toBe(wire[1]!.tool_calls![0]!.id);
    expect(srv.seen.at(-1)!.headers.authorization).toBeUndefined();
  });

  it('lists models with context length and checks health', async () => {
    expect(await adapter().listModels()).toEqual([{ name: 'Qwen/Qwen2.5-7B-Instruct', contextTokens: 16384, supportsStructuredOutput: true }]);
    expect(await adapter().health()).toMatchObject({ ok: true });
    expect(adapter().adapter).toBe('vllm');
  });
});
