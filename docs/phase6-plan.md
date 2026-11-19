# Phase 6 plan: executions and test cases

Started 19 Nov 2026, after the Phase 5 sign-off. The menu used to say these screens arrive in Phase 5. The Phase 5 that shipped is the runner and the reachability check. These screens are this phase.

## Status (19 Nov 2026)
Slice 1 is confirmed. The user opened Executions and could see the run list.

Slice 2 is ready to review. Test Cases stores cases in this platform. Saving changed steps or an expected result keeps the previous version. A collection names a set of those cases. Nothing is written to the current Squash. A business user can read the library. A QA engineer or QA lead can add and revise it.

A requirement-validation run records each stage. playwright-test-planner writes the test plan from the story and acceptance criteria. playwright-test-generator writes a Playwright test for each scenario. The publish step stores those cases in Test Cases and in Squash. The Squash connector is read and write, and it needs a READ_WRITE token. The run page and Executions show Done as each stage finishes. Screenshots are not captured in this run.

## Slices
1. **Execution history.** One list across workflows. Open a run to see its events and, while it is still open, pause, resume, or cancel it.
2. **Test case library.** Cases kept by this platform, with versions and a collection a regression workflow can name. A requirement-validation publish also stores the generated cases in Squash.

## Not in this phase
A test suite inside the runner, driving the browser, and pushing execution results back to Squash. The order for that remaining work is [requirement-validation-implementation.md](requirement-validation-implementation.md). The phases that carry it are [requirement-validation-phases.md](requirement-validation-phases.md).
