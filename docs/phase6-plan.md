# Phase 6 plan: executions and test cases

Started 19 Nov 2026, after the Phase 5 sign-off. The menu used to say these screens arrive in Phase 5. The Phase 5 that shipped is the runner and the reachability check. These screens are this phase.

## Status (19 Nov 2026)
Slice 1 is confirmed. The user opened Executions and could see the run list.

Slice 2 is ready to review. Test Cases stores cases in this platform. Saving changed steps or an expected result keeps the previous version. A collection names a set of those cases. Nothing is written to the current Squash. A business user can read the library. A QA engineer or QA lead can add and revise it.

A requirement-validation run now records each stage. It reads the story text and any acceptance criteria in it, writes a test plan, notes that the UI and the repository were not driven in this run, generates the cases, and stores them in Test Cases under that work item. The run page and Executions show "Done" as each stage finishes. Publishing and result sync stay a preview: this Squash connection is read-only, so the cases are not added there and screenshots are not captured.

## Slices
1. **Execution history.** One list across workflows. Open a run to see its events and, while it is still open, pause, resume, or cancel it.
2. **Test case library.** Cases kept by this platform, with versions and a collection a regression workflow can name. No writes to the current Squash.

## Not in this phase
A test suite inside the runner, driving the browser, and pushing results back to Squash.
