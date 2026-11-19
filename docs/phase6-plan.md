# Phase 6 plan: executions and test cases

Started 19 Nov 2026, after the Phase 5 sign-off. The menu used to say these screens arrive in Phase 5. The Phase 5 that shipped is the runner and the reachability check. These screens are this phase.

## Status (19 Nov 2026)
Slice 1 is ready to review. Executions lists runs that have already been started, with status, step, and the recorded events. Pause, resume, and cancel use the same commands as the workflow page. A queued or running list refreshes itself.

Slice 2 is not started. Test Cases is a library in this platform: cases, versions, and collections. It does not create or change anything in the current Squash. That instance stays read-only.

## Slices
1. **Execution history.** One list across workflows. Open a run to see its events and, while it is still open, pause, resume, or cancel it.
2. **Test case library.** Cases kept by this platform, with versions and a collection a regression workflow can name. No writes to the current Squash.

## Not in this phase
A test suite inside the runner, driving the browser, and pushing results back to Squash.
