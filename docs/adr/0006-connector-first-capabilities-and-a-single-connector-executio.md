# ADR 0006: Connector-first: capabilities and a single Connector Execution Manager

Status: accepted (Phase 1)

## Context

Every external system (work items, source repositories, test management, browser, runner) must be swappable, and the rules about what may be done (read-only, scope, approvals) must hold even if one component has a bug.

## Decision

Each operation is a named capability with an access mode (read or write) and validated input and output. Workflow steps and agents hold no HTTP client; they call `ConnectorExecutionManager.invoke`, which resolves the connector instance, applies machine policy and constraints, leases the secret, enforces rate limits and timeouts, redacts output and writes an audit entry. Effective capabilities are declared, probed and permitted, never assumed.

## Consequences

Policy and audit exist in exactly one place. Providers are small adapters tested with one contract kit. The price is an indirection for every external call.

## Evidence

`packages/connector-sdk`, `packages/testing` (contract kit, fakes), `packages/infrastructure/src/connectors/squash`.
