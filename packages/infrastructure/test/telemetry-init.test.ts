import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { EgressPolicy, initTelemetry, type EgressRule } from '../src';

const policy = (rules: EgressRule[], profile: 'standard' | 'airgapped' = 'standard') => new EgressPolicy({ rules, profile, platformEnv: 'development' });

describe('initTelemetry', () => {
  it('does nothing and exports nothing without an endpoint', async () => {
    const h = initTelemetry({ serviceName: 'api', profile: 'standard', env: {} });
    expect(h.enabled).toBe(false);
    await h.shutdown();
  });

  it('can be switched off explicitly', () => {
    expect(initTelemetry({ serviceName: 'api', profile: 'standard', env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' } }).enabled).toBe(false);
  });

  it('refuses a collector that is not an approved host, and any export in air-gapped mode without a policy', () => {
    expect(() => initTelemetry({ serviceName: 'api', profile: 'standard', env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com' }, egress: policy([]) })).toThrow();
    expect(() => initTelemetry({ serviceName: 'api', profile: 'airgapped', env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' } })).toThrow(/egress policy/);
    expect(() => initTelemetry({ serviceName: 'api', profile: 'standard', env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url' } })).toThrow(/valid URL/);
  });

  it('exports spans to an approved internal collector over OTLP/HTTP', async () => {
    const received: { url: string; bytes: number }[] = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', bytes: Buffer.concat(chunks).length });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    const port = (collector.address() as AddressInfo).port;
    const h = initTelemetry({
      serviceName: 'api-test',
      profile: 'standard',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` },
      egress: policy([{ hostPattern: '127.0.0.1', purpose: 'application', internal: true, allowHttp: true, allowLoopback: true }]),
    });
    expect(h).toMatchObject({ enabled: true, endpoint: `http://127.0.0.1:${port}` });
    trace.getTracer('qa-platform').startSpan('probe').end();
    await h.shutdown();
    collector.close();
    expect(received.some((r) => r.url === '/v1/traces' && r.bytes > 0)).toBe(true);
  });
});
