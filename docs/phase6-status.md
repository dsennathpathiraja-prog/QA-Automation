# Phase 6 status: store cases, then prepare by work item

Last updated: 19 Nov 2026. Branch `cursor/phase1-foundation-2990` (this change lands through `cursor/phase6-status-af35`).
Plan: [`phase6-plan.md`](phase6-plan.md). Split with later work: [`requirement-validation-phases.md`](requirement-validation-phases.md).

## Status: code complete, awaiting your confirmation

`pnpm check` is green (396 tests). Slice 1 (Executions run list) was confirmed earlier the same day. Slice 2 (Test Cases under the work item, Squash store on publish, prepare-on-Executions) is in the code. Phase 6 closes when you confirm a **new** requirement-validation run stores cases in Test Cases and in Squash. Run `1436518e` stays the old empty success; rebuilding does not change that row.

### Done in this phase
| Item | Where |
|------|-------|
| Executions lists workflow runs; open a run for events; pause / resume / cancel while open | `apps/web/src/pages/Executions.tsx`, execution APIs |
| Executions prepares one work item against an environment; row stays **prepared** (no Playwright run, no screenshot) | `work_item_execution` migration, `TestCaseService.startWorkItemExecution` |
| Test Cases groups generated cases by work item; collection named for the work item; versions; QA can revise | `apps/web/src/pages/TestCases.tsx`, `TestCaseService.fileUnderWorkItem` |
| RV ends at publish (engine skips execute / sync / report on old definitions too) | `packages/workflow-engine/src/engine.ts`, templates |
| RV start does not require an environment | `WorkflowService.start`, Run tab |
| Squash connector is read/write; `tm.testcase.upsert` stores by reference; needs a READ_WRITE token | Squash provider, worker `publishGeneratedCases` |
| Clear message when Squash is switched off or cannot read cases | `workflow-service`, validator |

Not in this phase: running the Playwright file, screenshots, writing execution status back to Squash, regression.

## What you verify (closes Phase 6)

Do these on your machine with Docker. Sign in as `trial-lead` or `trial-engineer` (password `Trial-Pass-1`) unless a step says otherwise.

1. **Rebuild Docker** so migrations and the new images are loaded:
   ```
   docker compose -f deploy/compose/local/docker-compose.local.yml up --build
   ```
   Open http://localhost:8088 when the log settles. If port 8088 is taken, use `WEB_PORT=9000` as in [`phase1-status.md`](phase1-status.md).

2. **Squash READ_WRITE.** Open the Squash connector. Put a **READ_WRITE** personal API token in (replace a READ-only token). Run **Test Connection**, then **Switch on**. The check should say the token can store generated test cases. If the token is still READ, a later publish will keep cases in Test Cases and say Squash refused the store.

3. **Workflow republish.** Open your requirement-validation workflow. If it was published before this phase, create a fresh draft from the Standard Requirement Validation template (or duplicate and replace the definition), bind Squash (and a work-item connector if you use one), **Check**, send for approval, and **Approve and publish**. An old published version may still list execute / sync / report in its frozen definition; the worker skips those, but a republish picks up the short step list and optional environment.

4. **Run RV without an environment.** On the Run tab you should see story and application name, and **not** be asked for an environment. Paste a work item id on the first line, an `Acceptance criteria` heading, then one criterion per line. Start the run. When it finishes, the last Done line should say the cases were stored in Test Cases and in Squash (or explain why Squash did not accept them).

5. **Confirm Test Cases.** Open **Test Cases**. The work item appears as a group with the generated cases and a collection of that name. Open a case; a business user (`trial-user`) can read it; an engineer can revise and save a new version.

6. **Confirm Executions.** Open **Executions**. Choose that work item and a selectable environment, then **Prepare execution**. The row stays prepared and does **not** say the tests passed. Workflow runs that created the cases stay listed under Workflow runs.

Healthy result: steps 4–6 show new cases for that work item in Test Cases and in Squash, and a prepared execution row with no pass/fail or screenshot.

If something fails, send: `docker compose -f deploy/compose/local/docker-compose.local.yml ps`, logs for `api` and `worker`, which step number failed, and a screenshot of the page.

### Squash publish says 401 / “rejected the API token” but Test Connection works

That is expected when the personal token is **READ** only. Test Connection only calls `GET /projects`. Storing generated cases uses `POST .../test-cases`, and Squash answers **401** for a READ token on write (same wording as a bad token).

Check, in order:

1. **Same connector on the workflow.** On the workflow Connectors tab, Squash must be the connector you just tested (not “None” and not an older instance). Save the draft, republish, and run again.
2. **READ_WRITE token.** In Squash, create a personal API token with **read and write**. On the connector, **Replace credentials**, paste that token, **Test Connection** (it should say the token can store generated test cases), then **Switch on**.
3. **Restart the worker** after credential or compose changes so it leases the new secret (`docker compose ... restart worker`, or a full rebuild).

Publish and Test Connection both lease `connectors/<id>/credentials` and call the same Squash `create` → `send` path: `Authorization: Bearer <trimmed token>` only (never `Token`, Basic, X-Api-Key, username/password, or a bare token). Username/password in the secret bag are ignored when a token is present and rejected when the token is missing. URL userinfo is stripped from the Squash `baseUrl` and by the hardened HTTP client so fetch cannot synthesize Basic. There is no separate publish token. A 401 message may include a short Squash response snippet (token redacted); if Squash says Basic is not allowed, the message tells you to replace credentials with a personal API token.

## How to resume after your reply
1. `git checkout cursor/phase1-foundation-2990 && git pull` (merge the status PR if it is still open).
2. `pnpm install && pnpm check`.
3. Tick this file from your confirmation, mark Phase 6 done in [`phase6-plan.md`](phase6-plan.md) and the README, then continue with executing prepared work items (after Phase 6 in [`requirement-validation-phases.md`](requirement-validation-phases.md)).
