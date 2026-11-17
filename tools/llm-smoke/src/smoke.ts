import { z } from 'zod';
import { EgressPolicy, HardenedHttpClient, OllamaAdapter } from '@qa/infrastructure';
import { LlmGateway, StaticAssignmentResolver, StaticProviderRegistry, fromZod, type LlmAuditEntry } from '@qa/llm';

/**
 * Smoke test of the LLM path against a real Ollama: model listing, health, a structured-output call and one tool-loop
 * step, all through the gateway. Usage: OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:0.5b pnpm --filter @qa/llm-smoke smoke
 */
const url = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const wanted = process.env.OLLAMA_MODEL;
const u = new URL(url);

const http = new HardenedHttpClient({
  egress: new EgressPolicy({ rules: [{ hostPattern: u.hostname, purpose: 'llm', internal: true, allowHttp: u.protocol === 'http:', allowLoopback: true }], profile: 'airgapped', platformEnv: 'development' }),
  allowedMethods: ['GET', 'POST'],
  timeoutMs: 300_000,
});
const port = new OllamaAdapter({ baseUrl: url, http, keepAlive: '5m' });

const health = await port.health();
console.log('health', health);
if (!health.ok) process.exit(2);
const models = await port.listModels();
console.log('models', models.map((m) => `${m.name} ctx=${m.contextTokens ?? '?'} tools=${m.supportsToolCalling ?? '?'} vision=${m.supportsVision ?? '?'}`));
const model = models.find((m) => m.name === wanted) ?? models[0];
if (!model) {
  console.error('no models installed; run: ollama pull qwen2.5:0.5b');
  process.exit(3);
}

const audit: LlmAuditEntry[] = [];
const gw = new LlmGateway({
  registry: new StaticProviderRegistry([{ descriptor: { id: 'ollama', kind: 'local', enabled: true, allowedDataClasses: ['story', 'code', 'page', 'screenshot', 'test-data', 'evidence'], concurrencySlots: 1, models: [{ ...model, supportsToolCalling: model.supportsToolCalling ?? false }] }, port }]),
  assignments: new StaticAssignmentResolver({ smoke: { primary: { providerId: 'ollama', model: model.name }, maxOutputTokens: 400, temperature: 0 } }),
  redactor: { redact: (s) => s },
  audit: { append: async (e) => void audit.push(e) },
  profile: 'airgapped',
  requestTimeoutMs: 280_000,
});

const Plan = z.object({ title: z.string(), scenarios: z.array(z.string()).min(1) });
const structured = await gw.generateStructured(
  { agentKey: 'smoke' },
  { system: 'You are a QA planner. Reply with JSON only.', instruction: 'List test scenarios for the story below.', context: [{ class: 'story', label: 'story', text: 'As a user I can reset my password using an emailed link.' }] },
  fromZod(Plan),
);
console.log('structured', JSON.stringify(structured.data), `repaired=${structured.repaired}`, structured.usage);

if (model.supportsToolCalling) {
  const step = await gw.toolLoopStep(
    { agentKey: 'smoke' },
    { system: 'You can call tools.', instruction: 'Use the tool to add 2 and 3.' },
    [{ name: 'add', description: 'Add two numbers', input: fromZod(z.object({ a: z.number(), b: z.number() })) }],
  );
  console.log('tool step', JSON.stringify(step.kind === 'tool_calls' ? step.calls : step.text));
} else {
  console.log('tool step skipped: model does not advertise tool calling');
}
console.log('audit', audit.map((a) => `${a.outcome}:${a.model}:${a.usage?.inputTokens}/${a.usage?.outputTokens}:${a.durationMs}ms`));
