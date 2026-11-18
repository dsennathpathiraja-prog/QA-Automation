# Phase 3 plan: durable workflow engine

Started Nov 18, 2026, after the Phase 2 sign-off. Scope comes from ADR 0004 and ADR 0001. The roadmap file named in the README is not in this checkout, so this plan does not invent the QA step catalog. The engine comes first. The steps that publish test cases, call connectors, or launch runners are later slices, and they call this engine rather than the other way around.

## What we already have
- A worker process with a tick loop, health, and a clean stop. The tick currently runs connector tests only. ADR 0004 says the engine extends that tick.
- Postgres, reviewed migrations, and append-only audit tables.
- Role permissions for creating, editing, publishing, and viewing workflows. No workflow tables yet.

## Decisions already taken
- The engine is ours, on Postgres, behind an `ExecutionRuntime` port. Not Temporal.
- The API does not run workflows. The worker does.
- A step runs at least once. Every side effect carries an idempotency key so a retry does not do the work twice.
- Claiming work uses `SELECT ... FOR UPDATE SKIP LOCKED` and a lease. An append-only event log is the history the UI will read.
- A test must kill a worker in the middle of a step and show the step recovers. That chaos suite is mandatory.
- Source repositories stay read-only. The current Squash stays read-only. A workflow that would write there stays in preview until a separate writable connector is enabled.

## Slices
1. **Tables and the event log.** Workflow definition, immutable published version, execution, step attempt with a lease, and an append-only execution event table. Migrations and database checks only. Nothing runs yet.
2. **Runtime port.** Start an execution of a published version, claim the next step, heartbeat the lease, complete, and fail. A second worker does not claim a live lease. Tests use PGlite, plus the real Postgres suite when `TEST_DATABASE_URL` is set.
3. **Worker tick.** The existing connector tick stays. The engine claims one step per tick. Stopping the process releases nothing that another worker cannot recover after the lease expires.
4. **Chaos suite.** Kill the worker after the side effect is recorded and before the step is marked complete: the retry does not repeat the side effect. Kill it before the side effect: the retry runs it once.
5. **One visible workflow.** A fixed sample definition, an API to start it and read its events, and a page that shows the run. This is the first thing a person can click. Real QA steps are not in this slice.

## Not in Phase 3
Runner images, the Kubernetes runner, and the workflow editor for arbitrary steps. Those stay on their own phases (runner wiring is Phase 5, Kubernetes is Phase 11).
