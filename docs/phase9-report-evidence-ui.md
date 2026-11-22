# Report and Evidence UI (QA-74)

Operators open finished Regression / work-item runs and review:

| Surface | Route | Role |
|---------|-------|------|
| **Reports** | `/reports` | List of finished runs → opens dedicated run page |
| **Evidence** | `/evidence` | List of finished runs → opens dedicated run page |
| **Run detail** | `/runs/<executionId>?view=report\|evidence` | Tallies, charts, `regression-report.md`, screenshots |
| **Legacy** | `/reports?focus=` / `/evidence?focus=` | Redirects to `/runs/<id>` |

## Behaviour

- Reuses existing APIs: `GET /api/v1/work-item-executions/:id`, screenshot GET, and workflow `events` for report Markdown (no new ObjectStore report endpoint).
- **Open report / Open evidence** navigate to the dedicated `/runs/$id` page (not inline under the list); report view shows stacked-bar + donut charts for outcome tallies.
- Workflow **Run & output** shows **Open report** / **Open evidence** when execute outputs include `evidenceExecutionId`.
- Report Markdown evidence links deep-link to `/evidence?focus=…` (not the raw screenshot JSON API).
- Automation Mapping sync/resolve/scope tools are unchanged and not required for reviewing finished runs.

## Verify (PowerShell-safe)

From the repository root:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

1. Finish a Regression run (or a work-item Playwright run with screenshots).
2. Open **Reports** or **Evidence** from the nav, or click **Open report** on Workflow Run & output / Executions History.
3. Confirm tallies, expandable `regression-report.md` (Regression only), and screenshot browsing on Evidence.
