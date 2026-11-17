import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, execPolicy, makeInstance, makeStubWorkItemProvider } from '../src';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => provider.shutdown());
beforeEach(() => exporter.reset());

const actor = { type: 'step' as const, id: 's', executionId: 'ex1', stepId: 's1' };

describe('Connector Execution Manager telemetry', () => {
  function harness() {
    return createHarness({
      providers: [makeStubWorkItemProvider([{ id: '42', title: 'Guest checkout with card 4111111111111111' }])],
      instances: [makeInstance({ id: 'wi1', providerKey: 'stub-work-items', category: 'work-item', secretLocator: 'connectors/wi1/token' }, ['workitem.read'])],
      policies: { ex1: execPolicy({ boundRoles: { workItemSource: 'wi1' } }) },
    });
  }

  it('records one span per call with capability and outcome, and nothing from inputs, outputs or secrets', async () => {
    const h = harness();
    await h.secrets.put('connectors/wi1/token', { token: 'tok-very-secret-1234' });
    await h.manager.invoke({ role: 'workItemSource', capability: 'workitem.read', input: { id: '42' }, actor });
    const [s] = exporter.getFinishedSpans();
    expect(s!.name).toBe('connector.invoke');
    expect(s!.attributes).toMatchObject({ capability: 'workitem.read', 'actor.type': 'step', 'connector.role': 'workItemSource', outcome: 'ok' });
    const dump = JSON.stringify({ a: s!.attributes, e: s!.events, st: s!.status });
    for (const leaked of ['tok-very-secret', '4111111111111111', 'Guest checkout']) expect(dump).not.toContain(leaked);
  });

  it('marks a denied call with its error class', async () => {
    const h = harness();
    await h.secrets.put('connectors/wi1/token', { token: 'tok-very-secret-1234' });
    await expect(h.manager.invoke({ role: 'workItemSource', capability: 'tm.testcase.upsert', input: {}, actor })).rejects.toBeTruthy();
    const [s] = exporter.getFinishedSpans();
    expect(s!.attributes).toMatchObject({ outcome: 'denied', 'error.class': 'denied' });
    expect(s!.status.code).toBe(2);
  });
});
