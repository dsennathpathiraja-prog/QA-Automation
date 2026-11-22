# Phase 9 E6 — Deny-list & operator polish

Regression executions must never generate cases, explore UI/code, or invoke agents. The workflow type deny-list is proven in tests, and operators get a clear path from Executions / Run wizard. Mapping approve APIs remain for seed/ops; the Automation Mapping / AI Agents / AI Models operator screens were removed from product nav.

## Deny-list

Regression policy (TYPE_SPECS + every `tpl-rg-*` template):

| Pattern | Blocks |
|---------|--------|
| `tm.testcase.upsert` | Creating / upserting Squash cases during Regression |
| `scm.*` | Source-repo explore |
| `browser.*` | Browser MCP explore |
| `agent.*` | Agent-capability family (reserved) |

Integration proof: `packages/testing/test/regression-deny-list.test.ts` — under a Regression execution policy, attempted invokes are **denied** and the operation log has **no `ok`** entries matching those patterns. Template coverage: `packages/workflow-definitions/test/validator.test.ts`.

## Operator polish

| Surface | Behaviour |
|---------|-----------|
| **Executions** | Regression entry card → Workflows + Reports + Evidence; History notes Regression vs RV |
| **Workflow Run** | Warning: approve before run; draft/unmapped → Not Automated |
| **Steps** | Same approve-before-run reminder for Regression workflows |

## Verify (PowerShell-safe)

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

1. Ensure at least one mapping is approved (seed/publish path or `POST /api/v1/automation/assets/:id/approve`).
2. Open **Executions** → Regression → **Open Workflows** (or create Full / Selected / Smoke from a template).
3. On the workflow **Run & output** tab, confirm the approve-before-run warning, then start with environment + scope.
4. Confirm draft/unmapped cases are Not Automated; operation log for the run has no successful `tm.testcase.upsert` / `scm.*` / `browser.*` / `agent.*`.
