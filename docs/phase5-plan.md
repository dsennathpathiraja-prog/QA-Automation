# Phase 5 plan: runner and environment reachability

Started 19 Nov 2026, after the Phase 4 sign-off. This is the runner work named in the Phase 1 status, not the model-qualification note in ADR 0009.

## Status (19 Nov 2026)
Slice 1 is confirmed. The user pressed Check reachability and the page showed "The application answered 200."

Slices 2 and 3 are ready to review. With the runners profile up, the same button places the check in a runner container. The page then says "The runner finished. The application answered 200." The launcher is the only service with the container socket. It pins the local image to its current digest and refuses any other image. If that service is not running, the worker still checks the address itself, so the earlier result keeps working.

Slice 4 stays a no-op. This runner only checks one address. It does not run a test suite, so `rv.execute-tests` and `rg.execute-tests` still record the step and do nothing else. A published workflow run keeps succeeding.

## Slices
1. **Reachability from the worker.** Queue a check, claim it, call the application address, store the result. Confirmed by the user.
2. **Runner image.** `apps/runner/check.mjs` receives one address, calls it only when the host is on the allowlist, and exits when it answers or does not. The image is `qa-runner:local`. The launcher turns that into `qa-runner@sha256:...` from the engine's image id.
3. **Launcher wiring.** When `runner-launcher` is up, the worker asks it to place the check. Local trial without that profile keeps the worker call.
4. **Execute steps.** `rv.execute-tests` and `rg.execute-tests` stay no-ops. There is no test bundle for a runner to execute yet.

## Not in this phase
Kubernetes. That is Phase 11. Creating test cases in Squash, reading a story, and driving the browser stay later as well.
