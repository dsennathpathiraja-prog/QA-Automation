# ADR 0004: Custom durable workflow engine on PostgreSQL, behind a port

Status: accepted (Phase 1)

## Context

Workflows are versioned definitions with roughly seven to ten steps, interpreted by the platform. Temporal would give mature durability but needs its own cluster and forces deterministic workflow code and a generic interpreter on top.

## Decision

Build a small engine on Postgres (leases, an append-only event log, `SELECT ... FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`) behind an `ExecutionRuntime` port. Step execution is at-least-once and every side effect is idempotent. Temporal is the documented migration path.

## Consequences

No new infrastructure, and state is transparent to the UI. The team owns the engine, so the Phase 3 chaos suite (killing workers mid-step) is mandatory. Switch criteria: more than 100 concurrent executions, multi-day waits, or engine bugs consuming real effort.

## Evidence

Phase 1 delivers the worker loop (`apps/worker`) and the Postgres schema and migration pipeline; the engine itself is Phase 4.
