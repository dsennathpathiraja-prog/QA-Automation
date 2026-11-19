# Phase 6 plan: executions and test cases

Started 19 Nov 2026, after the Phase 5 sign-off. The menu used to say these screens arrive in Phase 5. The Phase 5 that shipped is the runner and the reachability check. These screens are this phase.

## Status (19 Nov 2026)
Slice 1 is confirmed. The user opened Executions and could see the run list. That list was the workflow runs, including the old empty success 1436518e. It is not the execution of a work item.

The requirement-validation workflow now ends when the cases are stored. Test Cases groups those cases under the work item and keeps them in a collection of that name. It does not open on a hand-written form. Executions prepares a run of one work item against an environment chosen on that page. The runner has not executed the Playwright file, so that row stays prepared. Screenshots are not captured.

playwright-test-planner writes the test plan from the story and acceptance criteria. playwright-test-generator writes a Playwright test for each scenario. Publish stores those cases in Test Cases and in Squash. The Squash connector is read and write for that store, and it needs a READ_WRITE token. A business user can read the library. A QA engineer or QA lead can revise a generated case.

## Slices
1. **Execution history.** One list across workflows. Open a run to see its events and, while it is still open, pause, resume, or cancel it.
2. **Test case library.** Cases kept by this platform, with versions and a collection a regression workflow can name. A requirement-validation publish also stores the generated cases in Squash.

## Not in this phase
Executing the Playwright file, capturing a screenshot, or writing an execution status back to Squash. Regression, which reads the stored cases from Squash and does not generate new ones. The split is in [requirement-validation-phases.md](requirement-validation-phases.md).
