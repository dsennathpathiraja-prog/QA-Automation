# Phase 4 plan: workflow definition and the engine

Started after the Phase 3 sign-off. This is the roadmap Phase 4, not a new reading of Phase 3.

## Slices
1. **Draft records.** Name, type (requirement validation or regression), and an empty definition shell. QA Lead and Administrator can create. A person who can only view published workflows does not see drafts. No steps, publish, or run yet.
2. **Step registry and validator.** Step types as data. `WorkflowValidator` rules V1–V11. A draft with a broken graph cannot be saved as ready.
3. **Versions and publish.** Immutable version, content hash, QA Lead approval. Business users see published workflows only.
4. **Engine.** Leases, append-only event log, pause/resume/cancel, retries. The worker runs it. The API does not. ADR 0004.
5. **Durability proof.** A no-op demo workflow survives a worker killed mid-step, without repeating a side effect.
6. **Builder UI.** Guided list first. Flow view is read-only. Run wizard framework.

## Not in the first slice
Templates, the chaos suite, and starting a real Requirement Validation or regression run. Those follow the slices above.
