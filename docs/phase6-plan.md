# Phase 6 plan: executions and test cases

Started 19 Nov 2026, after the Phase 5 sign-off. The menu used to say these screens arrive in Phase 5. The Phase 5 that shipped is the runner and the reachability check. These screens are this phase.

## Status (19 Nov 2026)
Code for both slices is in place and `pnpm check` is green. Slice 1 was confirmed by the user (Executions showed the workflow run list, including the old empty success 1436518e). Slice 2 is ready for confirmation: Test Cases groups cases under the work item; publish stores them there and in Squash; Executions prepares a work item against an environment and leaves the row prepared.

Hand-off and the Docker / Squash / republish / run checklist: [`phase6-status.md`](phase6-status.md). Phase 6 closes when that confirmation is done.

playwright-test-planner writes the test plan from the story and acceptance criteria. playwright-test-generator writes a Playwright test for each scenario. Publish stores those cases in Test Cases and in Squash. The Squash connector is read and write for that store, and it needs a READ_WRITE token. A business user can read the library. A QA engineer or QA lead can revise a generated case. A requirement-validation template no longer binds a test runner; execution of the Playwright file is after this phase.

## Slices
1. **Execution history.** One list across workflows. Open a run to see its events and, while it is still open, pause, resume, or cancel it.
2. **Test case library.** Cases kept by this platform, with versions and a collection a regression workflow can name. A requirement-validation publish also stores the generated cases in Squash.

## Not in this phase
Executing the Playwright file, capturing a screenshot, or writing an execution status back to Squash. Regression, which reads the stored cases from Squash and does not generate new ones. The split is in [requirement-validation-phases.md](requirement-validation-phases.md).
