# Phase 8 E6 — Regression seed (automation mappings)

Minimum foundation for Regression: **draft → approved** automation assets plus a Squash case ↔ platform script mapping. Full Regression UI (collections, campaigns) stays out of scope.

## Data model

| Table | Role |
|-------|------|
| `automation_asset` | Platform script asset (`key`, `script_path`, `script_body`, `status` draft\|approved) |
| `automation_mapping` | Unique `squash_case_id` → `asset_id` |

Migration: `packages/persistence/migrations/0017_automation_assets.sql`.

## API

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/v1/automation/assets` | `automation.view` |
| POST | `/api/v1/automation/assets` | `automation.register` |
| POST | `/api/v1/automation/assets/:id/approve` | `automation.approve` |
| GET | `/api/v1/automation/mappings` | `automation.view` |
| POST | `/api/v1/automation/mappings` | `automation.register` |
| GET | `/api/v1/automation/resolve?squashCaseId=` | `automation.view` |

**Acceptance:** at least one Squash case resolves to a platform automation asset id via `GET …/resolve`.

## How rows get created

1. **Automatic (preferred):** publishing generated cases with a writable Squash connector seeds a **draft** asset + mapping per stored Squash id.
2. **Manual:** `POST /api/v1/automation/assets` with `squashCaseId` (and optional `squashReference`).
3. **Approve:** QA Lead / Administrator uses Automation Mapping → **Approve**, or `POST …/assets/:id/approve`. Regression runners should require `approved: true`.

## Thin UI

**Automation Mapping** (`/automation`) lists mappings, approve drafts, and resolve a Squash case id. It is not a full Regression workspace.

## Verify (PowerShell-safe)

From the repository root:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

After migrate-on-start, either publish a case to Squash or register via API, then:

```powershell
# Example: resolve Squash case 238 (replace id). Use a session cookie from the signed-in browser, or call from Automation Mapping → Resolve.
# GET /api/v1/automation/resolve?squashCaseId=238
# Expect JSON with assetId, scriptPath, and status draft|approved.
```

In the UI: sign in as `trial-lead` → **Automation Mapping** → confirm the row → **Approve** → **Resolve** shows the platform asset id.
