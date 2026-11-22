# Phase 7 plan: execute prepared work items

Started 19 Nov 2026, after Phase 6 (store cases, prepare by work item). Product split: [`requirement-validation-phases.md`](requirement-validation-phases.md). Implementation notes: [`requirement-validation-implementation.md`](requirement-validation-implementation.md) §§7–8.

## Status (19 Nov 2026)
Code for the execute path is in place. From Executions, a prepared work item can be **Run** against its environment. The worker uses the existing `runner-launcher` / `qa-runner` profile when available (`bundleRef: work-item`), otherwise probes the application from the worker. Each case gets Passed / Failed / Blocked / Skipped plus a screenshot. When a Squash connector is switched on with a READ_WRITE token (project name such as ToolKit-AgenFlow), the run writes execution status back to Squash.

Regression stays out of scope. Automation Mapping remains a later screen (nav placeholder).

## Slices
1. **Queue and run.** Prepare stays as Phase 6. **Run** sets the row to queued; the worker claims it and runs the cases.
2. **Playwright runner.** Same launcher and runner image as Phase 5. `main.mjs` dispatches to `execute.mjs` for `work-item`. Prefer Playwright when installed in the image; otherwise HTTP against the allowlisted host with evidence PNG.
3. **Per-case results.** Statuses Passed / Failed / Blocked / Skipped, screenshot on Executions, optional Squash execution id.
4. **Squash sync.** `tm.execution.upsert` + `tm.execution.status.update` on the writable Squash connector. Failures leave screenshots on Executions and say why Squash was not updated.

## Not in this phase
Regression workflow. Healer. Full Evidence library screen. Kubernetes. (Screenshot attachments into Squash: Phase 8 E4.)
