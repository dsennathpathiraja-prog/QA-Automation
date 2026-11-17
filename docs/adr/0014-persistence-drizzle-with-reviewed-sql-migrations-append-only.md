# ADR 0014: Persistence: Drizzle with reviewed SQL migrations, append-only audit

Status: accepted (Phase 1)

## Context

The audit trail must be trustworthy, and the schema must be controllable down to constraints and triggers.

## Decision

Postgres 16 with Drizzle ORM; migrations are plain SQL files applied by our own runner, which records a checksum for each and refuses to run if an applied file was edited. The audit log and operation logs are append-only (database triggers refuse updates and deletes) and the audit log is hash-chained under an advisory lock. Tests run both in-process (PGlite) and against real Postgres.

## Consequences

Tampering is detectable and concurrent migrators are safe. Released migrations are never edited; fixes are new migrations.

## Evidence

`packages/persistence`, `packages/persistence/test/postgres.integration.test.ts`.
