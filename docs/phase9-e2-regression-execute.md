# Phase 9 E2 — Regression execute + evidence

`rg.execute-tests` runs **approved** Squash↔script mappings through the existing Playwright runner (same open-page + screenshot path as Executions). Draft / unmapped cases stay **Not Automated** (`Skipped`) — never executed, never generated or explored.

## Behaviour

| Piece | Role |
|-------|------|
| Prior `rg.resolve-automation` | Supplies `resolved` (approved only) + `notAutomated` |
| `rg.select-environment` | Thin resolve of run `environment` → `{ id, name, applicationUrl }` |
| `rg.execute-tests` | Runs approved assets via `runWorkItemCases`; Skipped for Not Automated |
| Evidence | Work-item execution row `rg:<workflowRunId>` with live progress + screenshots |

**Statuses:** Passed / Failed / Blocked / Skipped (Not Automated → Skipped with reason).

**Screenshots:** Stored on the evidence execution (`GET /api/v1/work-item-executions/:id/cases/:caseId/screenshot`). Step outputs carry `hasScreenshot` + `evidenceExecutionId` (no large base64 in the workflow event).

## Verify (PowerShell-safe)

From the repository root:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

1. Seed/approve one mapping (Automation Mapping) — leave a sibling draft.
2. Ensure runner-launcher is up (same as Executions screenshots).
3. Start a Regression workflow with `squashCaseIds` / scope covering both ids and an environment with an application URL — or after resolve, confirm execute step summary lists Passed (approved) and Skipped (Not Automated).
4. Open **Executions** → work item `rg:<runId>` for live progress and screenshots.

Squash status sync remains Phase 9 E5 (`rg.update-squash`).
