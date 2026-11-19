# Phase 5 plan: runner and environment reachability

Started 19 Nov 2026, after the Phase 4 sign-off. This is the runner work named in the Phase 1 status, not the model-qualification note in ADR 0009.

## Status (19 Nov 2026)
The first slice is in place. On an environment, Check reachability asks the worker to call the application address. The page shows whether it answered. The worker uses the approved-host list, the same rule as every other outbound call. A host that is not approved is recorded as unreachable, with that reason.

The published workflow still walks its steps without starting a runner. That stays until a runner image exists, so the run that already succeeded keeps working.

## Slices
1. **Reachability from the worker.** Queue a check, claim it, call the application address, store the result. Done in this slice.
2. **Runner image.** A small program that receives one address and exits when it answers or does not. The image is pinned by digest. The launcher accepts only that image.
3. **Launcher wiring.** When the runner service is configured, the worker asks it to place the check instead of calling the address itself. Local trial keeps the worker call so the button works without the container socket.
4. **Execute steps.** `rv.execute-tests` and `rg.execute-tests` stay no-ops until a runner can run them. They are not part of slice 1.

## Not in this phase
Kubernetes. That is Phase 11. Creating test cases in Squash, reading a story, and driving the browser stay later as well.
