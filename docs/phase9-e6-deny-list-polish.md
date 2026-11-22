# Phase 9 E6 — Deny-list & operator polish

Regression executions must never generate cases, explore UI/code, or invoke agents. The workflow type deny-list is proven in tests, and operators get a clear path from Executions / Run wizard to approve mappings before run.

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
| **Executions** | Regression entry card → Workflows + Automation Mapping; History notes Regression vs RV |
| **Workflow Run** | Warning: approve before run; draft/unmapped → Not Automated (link to `/automation`) |
| **Steps** | Same approve-before-run reminder for Regression workflows |

## Verify (PowerShell-safe)

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

1. Approve at least one mapping on **Automation Mapping**.
2. Open **Executions** → Regression → **Open Workflows** (or create Full / Selected / Smoke from a template).
3. On the workflow **Run & output** tab, confirm the approve-before-run warning, then start with environment + scope.
4. Confirm draft/unmapped cases are Not Automated; operation log for the run has no successful `tm.testcase.upsert` / `scm.*` / `browser.*` / `agent.*`.
