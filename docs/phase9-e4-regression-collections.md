# Phase 9 E4 — Platform regression collections (smoke)

Curated platform collections store **Squash case ids** as members. Template #7 (Smoke Regression) pins `collectionKey: smoke` and expands those members into the case-id set for approved-only resolve (E1) and execute (E2) — **without Squash tags**.

## Data model

| Table | Role |
|-------|------|
| `regression_collection` | Collection key (unique), name, description |
| `regression_collection_member` | Ordered Squash case id members |

Migration: `packages/persistence/migrations/0018_regression_collections.sql`. Startup seeds the empty `smoke` collection (`seedRegressionCollections`).

## API

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/v1/automation/collections` | `automation.view` |
| GET | `/api/v1/automation/collections/:key` | `automation.view` |
| PUT | `/api/v1/automation/collections/:key/members` | `automation.register` — body `{ squashCaseIds: string[] }` |
| POST | `/api/v1/automation/collections/:key/sync-approved` | `automation.approve` — replace members with Squash ids from approved mappings |

`POST /api/v1/automation/scope` with `{ kind: "collection", collectionKey: "smoke" }` expands curated members (no caseIds override needed). Worker `rg.configure-scope` uses the same port.

## UI

- Smoke collection APIs (`…/collections/smoke/sync-approved`); scope kind **collection** defaults to `smoke`. Operator Mapping UI removed.
- **Workflow Run** — Smoke template pins selection; run wizard notes `collectionKey: smoke`.

## Verify (PowerShell-safe)

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

1. Approve at least one automation mapping.
2. `POST /api/v1/automation/collections/smoke/sync-approved`.
3. Expand scope with kind `collection` / key `smoke` (leave case ids empty) → case ids appear.
4. Preview Regression resolve, or start **Smoke Regression** with `squashScope` + environment.
