# Phase 1 status and resume point

Last updated: Nov 17, 2026 (Asia/Colombo). Branch `cursor/phase1-foundation-2990`.
This file is the hand-off: read it first when work resumes, and update it as items close.

## Milestone reached: "Phase 1 code complete, awaiting live validation"

Everything that can be built and proven without a Docker host, a real Keycloak, or the VPN-only Squash is done and green
(`pnpm check`: 275 tests pass, including 5 against a real OpenBao and 3 against a real Squid; the 3 Postgres integration
tests run in CI and ran green earlier on a real Postgres).

### Done in this milestone
| Item | Where | Proof |
|------|-------|-------|
| Architecture decision records (15) | `docs/adr/` | index in `docs/adr/README.md` |
| OpenTelemetry: API-only helper package, SDK start in `api` and `worker`, spans/metrics for HTTP requests, connector calls, LLM calls, worker ticks; export only to an approved endpoint; no payload data in spans | `packages/telemetry`, `packages/infrastructure/src/telemetry`, `apps/api/src/telemetry.ts` | span-content tests, real OTLP export to a local collector |
| Runner launcher service (`apps/runner-launcher`): token auth, validated specs, approved-registry check, fixed container hardening, pool limit, idempotent on runId, touches only containers it created, stops runners over their time limit | `apps/runner-launcher`, `packages/domain/src/container-engine.ts` | 17 service tests |
| Docker Engine adapter over a unix socket; `RemoteRunnerLauncher` for the worker; shared RunnerLauncher contract run against fake, remote and service | `packages/infrastructure/src/runner`, `packages/testing` | tests against a Docker API double on a real socket |
| Acceptance: api cannot read secrets back (real OpenBao, the repo's real policy files) | `packages/infrastructure/test/openbao.integration.test.ts` | passes; also: worker and launcher least privilege |
| Acceptance: api/web/agents may never call `.lease()` | architecture test | self-test proves the rule fires |
| Acceptance: no plaintext credentials in the repo | `tools/architecture-tests/src/secret-scan.test.ts` | scans all tracked files; one documented exception (local trial stack) |
| Acceptance: non-approved host blocked by the proxy | `packages/infrastructure/test/egress-proxy.integration.test.ts` | real Squid with `deploy/compose/squid/squid.conf` |
| Compose: `runner-launcher` (profile `runners`), `otel-collector` (profile `obs`), launcher token secret | `deploy/compose` | config parses; not run (see pending) |
| CI: OpenBao dev container and Squid installed so those tests run | `.github/workflows/ci.yml` | not yet run on GitHub |

## Pending before Phase 1 can be called closed

### A. Needs the user (cannot be done from the agent VM)
1. **Run the local trial stack and confirm login.** `deploy/compose/local/README.md`: `docker compose -f docker-compose.local.yml up --build`, open http://localhost:8080, sign in as `trial-lead` / `Trial-Pass-1`. Report what happens (errors, screenshots). This is the first real run of the images, nginx, Keycloak realm import and OIDC against real Keycloak.
2. **Confirm CI is green on GitHub** after the next push (new steps: Squid install, OpenBao container).
3. **Rotate the GitHub token** shared earlier in chat. It must be treated as exposed.
4. **Squid live check (Phase 2 starts with this):** create a READ-only Squash API token, run `tools/squash-probe` from the VPN-connected machine, share `squash-report.json`. Not needed to close Phase 1; needed before Phase 2 adapter work is trusted.

### B. Needs a Docker host (agent or user)
5. **Full Compose `core` profile run** (`deploy/compose/docker-compose.yml`, `scripts/install.sh` is marked UNTESTED): OpenBao init/unseal/policies/AppRoles, Keycloak client secret step (documented as manual commands at the end of `install.sh`), then acceptance: login with a mapped group works; an unmapped user sees no data.
6. **Build all images** (`api`, `web`, `worker`, `runner-launcher`) and fix whatever the first build shows.
7. **Runner launcher on a real engine:** `docker compose --profile runners up`, launch a trivial digest-pinned image through `RemoteRunnerLauncher`, confirm hardening flags with `docker inspect`, confirm the timeout sweep. Needs the `automation` network, the docker group id (`DOCKER_GID`) and `RUNNER_IMAGE_PREFIXES` set.

### C. Small code and docs items (agent can do next session)
8. `docs/development.md`: dev environment guide (prerequisites, `pnpm check`, how to run OpenBao and Squid tests locally, ports, profiles). The README covers the basics but the roadmap lists dev docs as a Phase 1 deliverable.
9. Update the "Not yet implemented" paragraph and status block in `README.md` to match this file as items close.
10. Mark Phase 1 status in the design document `architecture-and-roadmap.md` (coordinator-owned store copy) once A and B pass.

### Deliberately deferred (not Phase 1 work)
- **S3 object store adapter:** the roadmap says "S3 adapter in Phase 2+ if chosen"; `local-fs` is the Phase 1 adapter. Decide with the Q16 host sizing answer.
- **Kubernetes runner adapter** (Job + NetworkPolicy, Helm): Phase 11.
- **Worker wiring of `RemoteRunnerLauncher`** and real runner image: Phase 5.
- **Workflow engine tables and engine:** Phase 3.

## Known limits to remember
- Per-run host allowlists are passed to the runner (`QA_ALLOWED_HOSTS`) and enforced by it; the Squid list is global.
- The runner launcher holds the container socket and is root-equivalent on the host. Keep it off user-facing networks; consider a rootless engine or socket proxy before production.
- OpenBao listener runs without TLS on the internal network (tracked hardening item).
- OpenTelemetry export has been tested against a local OTLP receiver only, not a real backend.
- The local trial stack uses fixed throw-away passwords; never expose it beyond localhost.

## How to resume
1. `git checkout cursor/phase1-foundation-2990 && git pull`
2. `pnpm install && pnpm check` (add `TEST_OPENBAO_ADDR=http://127.0.0.1:8200` with a dev OpenBao running to include those tests: `bao server -dev -dev-root-token-id=root-test`).
3. Ask the user for the results of items A1 to A3, then work down B and C.
