# Phase 7 status: run prepared work items

Last updated: 19 Nov 2026. Plan: [`phase7-plan.md`](phase7-plan.md). Split: [`requirement-validation-phases.md`](requirement-validation-phases.md).

## Status: code complete

`pnpm check` should be green on this branch. Phase 7 closes when you confirm a prepared work item can be Run and shows per-case status (and Squash when writable).

### Done in this phase
| Item | Where |
|------|-------|
| Executions **Run** on a prepared (or failed) row; worker claims queued runs | `TestCaseService.queueWorkItemExecution`, `processWorkItemExecutions` |
| Runner `bundleRef: work-item` via existing launcher / `qa-runner` image | `apps/runner/main.mjs`, `execute.mjs`, `run-work-item.ts` |
| Per-case Passed / Failed / Blocked / Skipped + screenshot | migration `0012`, Executions detail |
| Squash execution status when connector is READ_WRITE (project name e.g. ToolKit-AgenFlow) | `tm.execution.upsert` / `tm.execution.status.update` |
| Squash screenshot attachments when WRITE (Phase 8 E4) | `tm.attachment.upload` on the execution; sync line degrades if Squash refuses; platform evidence stays |
| Regression kept out of scope | docs |

## What you verify

1. Rebuild Docker (include runners profile if you want the launcher path):
   ```
   docker compose -f deploy/compose/local/docker-compose.local.yml up --build
   ```
2. Squash READ_WRITE with project name **ToolKit-AgenFlow** (or your project), Switch on.
3. Have cases under a work item (Phase 6). On **Executions**, prepare that work item against an environment, then press **Run**.
4. The row moves through queued / running to completed (or failed). Open it: each case shows a status and a screenshot. When Squash accepted the write, the sync line and Squash execution ids appear. When attachments succeed, the sync line mentions uploaded screenshots; if Squash refuses attachments, the line warns and platform screenshots remain.

Healthy result: cases are no longer “Not run yet”; statuses and screenshots are on Executions; Squash shows the matching execution status (and attachment when writable) when the token can write.

PowerShell-safe local check (from repo root):

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
# After a Run with READ_WRITE Squash: open the work-item run — sync Alert should mention execution status
# and either "uploaded … screenshot attachment(s)" or a warning that attachments were not uploaded
# while CaseScreenshot images still render.
```
