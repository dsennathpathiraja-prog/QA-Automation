# Phase 9 E3 — Regression suite / campaign / collection scope

Operators select a Squash project plus suite or campaign (probe-aware), or a platform `collectionKey`, and Regression expands that into an ordered unique Squash case-id set for approved-only resolve (E1) then execute (E2).

## Behaviour

| Path | Role |
|------|------|
| `POST /api/v1/automation/scope` | Prep: body `{ kind, projectId?, campaignId?, iterationId?, collectionKey?, caseIds? }` → `{ caseIds, mode, … }` |
| Worker `rg.select-squash-project` | Records project from `squashScope` |
| Worker `rg.configure-scope` | Live Squash suite/campaign listing (or collection stub) → `outputs.scope.caseIds` |
| Worker `rg.resolve-automation` | Consumes `configure_scope.scope.caseIds` (unchanged E1) |

**Kinds**

- **suite** (`all-in-suite`): all test cases in the Squash project via `tm.testcase.list`. Explicit `suiteId` errors clearly when `tm.suite.list` is unsupported (Squash probe).
- **campaign**: campaign (+ optional iteration) → `GET /iterations/{id}/test-plan` via `tm.iteration.testplan.list`. Clear error when campaign/test-plan probe is unavailable or the plan is empty.
- **collection**: platform `collectionKey` (e.g. `smoke`) → curated Squash case id members (E4 `regression_collection`; see [`phase9-e4-regression-collections.md`](./phase9-e4-regression-collections.md)).
- **selected**: explicit `caseIds`.

## UI

- Scope/resolve APIs (and worker `rg.configure-scope`) expand to case ids → feed Regression prep. Operator Mapping UI removed.
- **Workflow Run** — Regression templates: `squashScope` / `selection` JSON fields + environment.

## Verify (PowerShell-safe)

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

```powershell
# POST /api/v1/automation/scope
# Body: { "kind": "selected", "caseIds": ["238", "239"] }
# Then POST /api/v1/automation/resolve-regression with those ids.
```

Or `POST /api/v1/automation/scope` then `POST /api/v1/automation/resolve-regression`. For live campaign listing, start a published Regression workflow with `squashScope` containing `projectId` + `campaignId`.
