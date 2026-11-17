import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context } from '@opentelemetry/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { safeAttributes, withSpan } from '../src';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  await provider.shutdown();
});
beforeEach(() => exporter.reset());

describe('telemetry helpers', () => {
  it('records a span with safe attributes and nests children', async () => {
    await withSpan('outer', { capability: 'tm.testcase.read' }, async () => withSpan('inner', { n: 1 }, async () => 'x'));
    const spans = exporter.getFinishedSpans();
    const inner = spans.find((s) => s.name === 'inner')!;
    const outer = spans.find((s) => s.name === 'outer')!;
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(outer.attributes).toEqual({ capability: 'tm.testcase.read' });
  });

  it('marks failures by error class and never exports the error message', async () => {
    const err = Object.assign(new Error('secret-bearing message: token=abc'), { errorClass: 'auth' });
    await expect(withSpan('call', {}, async () => { throw err; })).rejects.toBe(err);
    const [s] = exporter.getFinishedSpans();
    expect(s!.status).toEqual({ code: 2, message: 'auth' });
    expect(s!.attributes['error.class']).toBe('auth');
    expect(JSON.stringify({ a: s!.attributes, st: s!.status, e: s!.events })).not.toContain('abc');
    expect(s!.events).toEqual([]);
  });

  it('drops credential-like keys and truncates long values', () => {
    const a = safeAttributes({ ok: true, apiKey: 'x', Authorization: 'Bearer y', password: 'p', note: 'n'.repeat(500), gone: undefined });
    expect(Object.keys(a).sort()).toEqual(['note', 'ok']);
    expect(String(a.note).length).toBeLessThan(210);
  });
});
