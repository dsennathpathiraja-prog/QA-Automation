# ADR 0015: Observability: OpenTelemetry, with no payload data

Status: accepted (Phase 1)

## Context

Operators need traces and metrics, but spans and metrics can leak the data the platform is built to protect.

## Decision

Code uses only the OpenTelemetry API through `@qa/telemetry`, which is a no-op until a composition root starts the SDK. Export happens only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and the endpoint must pass the egress policy (so an air-gapped install cannot export outside). Spans record names, capability ids, outcomes, error classes, token counts and route patterns; they never record inputs, outputs, URLs, headers, user identifiers or error messages, and credential-like attribute names are dropped by the helper.

## Consequences

Tracing is safe to turn on in sensitive environments. Debugging a failure from a trace alone may need the audit log as well.

## Evidence

`packages/telemetry`, `packages/infrastructure/src/telemetry`, tests for API requests, the connector manager and OTLP export.
