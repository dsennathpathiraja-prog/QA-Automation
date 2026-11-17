import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, DevHeaderSessionResolver } from '../src';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

describe('API request telemetry', () => {
  const app = () => buildApp({ sessions: new DevHeaderSessionResolver('test'), profile: 'standard' });

  it('names the span by route pattern and records status, without url, query, headers or identity', async () => {
    const a = app();
    const secretQuery = 'token=super-secret-value';
    await a.inject({ method: 'GET', url: `/api/v1/me?${secretQuery}`, headers: { 'x-dev-user': 'alice@example.com', 'x-dev-groups': 'QA-Platform-Leads', authorization: 'Bearer abc' } });
    await a.inject({ method: 'GET', url: '/api/v1/connectors' });
    const spans = exporter.getFinishedSpans();
    const me = spans.find((s) => s.name === 'GET /api/v1/me')!;
    expect(me.attributes).toMatchObject({ 'http.route': '/api/v1/me', 'http.response.status_code': 200, 'http.request.method': 'GET' });
    const denied = spans.find((s) => s.name === 'GET /api/v1/connectors')!;
    expect(denied.attributes['http.response.status_code']).toBe(401);
    const dump = JSON.stringify(spans.map((s) => ({ n: s.name, a: s.attributes, e: s.events })));
    for (const leaked of ['super-secret-value', 'alice', 'Bearer', 'abc']) expect(dump).not.toContain(leaked);
  });

  it('records unknown paths as unmatched, so scanners cannot create unbounded span names', async () => {
    await app().inject({ method: 'GET', url: '/api/v1/does-not-exist-123' });
    expect(exporter.getFinishedSpans().map((s) => s.name)).toContain('GET unmatched');
  });
});
