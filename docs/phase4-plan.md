# Phase 4 note: workflow definition and the engine

Not started. The roadmap places this after environment management. Do not build it during Phase 3.

## What Phase 4 is
Workflow definitions and the visual builder, plus the durable engine: versions, publish and QA Lead approval, leases, an append-only event log, pause/resume/cancel, retries, and a chaos test that kills a worker mid-step. A trivial demo workflow with no-op steps proves a run survives a restart. ADR 0004 is the engine decision. The API does not run workflows; the worker does.

## Why it is not Phase 3
The roadmap (Phase 3, Environment management) is environments, secrets, production authorization, connector references, and the environments UI. The engine is listed under Phase 4 (Workflow definition and visual builder). A plan written earlier in this branch treated the engine as Phase 3. That plan is withdrawn. This note is the placeholder so the engine work is not lost.
