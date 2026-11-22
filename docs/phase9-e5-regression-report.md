# Phase 9 E5 — Regression report + Squash update

After `rg.execute-tests`, Regression finishes with Squash status sync and a deterministic Markdown report.

## Behaviour

| Piece | Role |
|-------|------|
| `rg.update-squash` | Pushes Passed/Failed/Blocked/Skipped status to Squash via `tm.execution.upsert` + `tm.execution.status.update` (screenshots via `tm.attachment.upload` when WRITE allows) |
| Degrade path | If no enabled `read_write` connector with `tm.execution.upsert`, step **succeeds** with an explicit summary (`No writable Squash connector is switched on`) — never silent |
| Evidence row | Refreshes Executions `rg:<runId>` `squashSync` with the sync / degrade line |
| `rg.regression-report` | Writes `reports/regression/<runId>.regression-report.md` with pass/fail/blocked/skipped/Not Automated tallies, evidence links, and Squash sync line |
| Previous-run compare | When a prior completed `rg:*` evidence run exists for the same environment, adds a compare section with status deltas |

**Deny-list:** sync uses execution caps only (`tm.execution.*` / `tm.attachment.upload`). It does not call `tm.testcase.upsert`, explore, or agents.

## Verify (PowerShell-safe)

From the repository root:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

1. Approve at least one automation mapping; run Regression through execute.
2. With a WRITE Squash connector switched on — `rg.update-squash` records execution statuses (and attachments when allowed).
3. With Squash read-only / no WRITE connector — sync summary shows the degrade message; report still marks Squash sync as degraded.
4. Open **Reports** (`/reports?focus=<evidenceExecutionId>`) or the report step artifact (`regression-report.md`) for tallies and optional previous-run compare. Screenshots: **Evidence** (`/evidence?focus=…`). See [`phase9-report-evidence-ui.md`](./phase9-report-evidence-ui.md).
