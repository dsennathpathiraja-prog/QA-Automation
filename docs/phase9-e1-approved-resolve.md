# Phase 9 E1 — Approved-only resolve & Not Automated

Regression may run only **approved** Squash↔platform script mappings. Draft, unmapped, or missing assets are **Not Automated** — never executed and never generated.

## Behaviour

| Path | Role |
|------|------|
| `GET /api/v1/automation/resolve?squashCaseId=` | Seed lookup (draft or approved) — Automation Mapping |
| `POST /api/v1/automation/resolve-regression` | Regression prep: body `{ "squashCaseIds": ["…"] }` → `resolved` + `notAutomated` |
| Worker step `rg.resolve-automation` | Same approved-only rules; outputs `{ resolved, notAutomated }` for later `rg.execute-tests` |

**Not Automated reasons:** `mapping-unapproved` | `no-mapping` | `asset-missing`

## UI

**Automation Mapping** (`/automation`): Approve drafts, single Resolve, and **Regression prep** preview (lists approved vs Not Automated before execute).

## Verify (PowerShell-safe)

From the repository root:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

Seed two mappings (publish to Squash or register), approve one on `/automation`, leave the sibling draft, then:

```powershell
# POST /api/v1/automation/resolve-regression
# Body: { "squashCaseIds": ["<approved-id>", "<draft-id>", "<missing-id>"] }
# Expect resolved = approved only; Not Automated for draft (mapping-unapproved) and missing (no-mapping).
```

Or use **Automation Mapping** → Approve one row → **Preview Regression resolve** with both Squash case ids.
