import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PlatformError, type DeploymentProfile } from '@qa/domain';
import type { EgressPolicy } from '../http/egress-policy';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  profile: DeploymentProfile;
  env?: Record<string, string | undefined>;
  /** The same egress policy that guards every other outbound call. */
  egress?: EgressPolicy;
}

export interface TelemetryHandle {
  enabled: boolean;
  endpoint?: string;
  shutdown(): Promise<void>;
}

const OFF: TelemetryHandle = { enabled: false, shutdown: async () => undefined };

/**
 * Exports traces and metrics over OTLP/HTTP, and only when an endpoint is configured
 * (OTEL_EXPORTER_OTLP_ENDPOINT). With no endpoint nothing leaves the process and instrumentation stays a no-op.
 * The endpoint is checked against the egress policy first, so an air-gapped installation cannot be pointed
 * at an outside collector by accident.
 */
export function initTelemetry(o: TelemetryOptions): TelemetryHandle {
  const env = o.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || env.OTEL_SDK_DISABLED === 'true') return OFF;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PlatformError('validation', 'OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL');
  }
  if (o.egress) o.egress.assertAllowed(url);
  else if (o.profile === 'airgapped') throw new PlatformError('denied', 'telemetry export needs an egress policy in the airgapped profile');

  const base = endpoint.replace(/\/+$/, '');
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': o.serviceName, 'service.version': o.serviceVersion ?? '0.0.0', 'deployment.environment.name': env.PLATFORM_ENV ?? 'development' }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }), exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000) })],
  });
  sdk.start();
  return { enabled: true, endpoint: `${url.protocol}//${url.host}`, shutdown: () => sdk.shutdown() };
}
