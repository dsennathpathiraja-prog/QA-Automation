# Phase 9 E1 — Approved-only resolve & Not Automated

Regression may run only **approved** Squash↔platform script mappings. Draft, unmapped, or missing assets are **Not Automated** — never executed and never generated.

## Behaviour

| Path | Role |
|------|------|
| `GET /api/v1/automation/resolve?squashCaseId=` | Seed lookup (draft or approved) |
| `POST /api/v1/automation/resolve-regression` | Regression prep: body `{ "squashCaseIds": ["…"] }` → `resolved` + `notAutomated` |
| Worker step `rg.resolve-automation` | Same approved-only rules; outputs `{ resolved, notAutomated }` for [`rg.execute-tests`](./phase9-e2-regression-execute.md) |

**Not Automated reasons:** `mapping-unapproved` | `no-mapping` | `asset-missing`

## UI

Operator **Automation Mapping** UI was removed from product nav. Approve drafts, single Resolve, and Regression prep preview remain available via the APIs above (lists approved vs Not Automated before execute).

## Verify (PowerShell-safe)

From the repository root:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

Seed two mappings (publish to Squash or register), approve one via API, leave the sibling draft, then:

```powershell
# POST /api/v1/automation/resolve-regression
# Body: { "squashCaseIds": ["<approved-id>", "<draft-id>", "<missing-id>"] }
# Expect resolved = approved only; Not Automated for draft (mapping-unapproved) and missing (no-mapping).
```

Or call approve + `POST /api/v1/automation/scope` (E3) and/or `POST /api/v1/automation/resolve-regression` with both Squash case ids.
