# Phase 1 status and resume point

Last updated: Nov 18, 2026 (Asia/Colombo). Branch `cursor/phase1-foundation-2990`.
This file is the hand-off: read it first when work resumes, and update it as items close.

## Status: Phase 1 code complete, awaiting sign-off checks

All code, tests, ADRs and docs that can be produced without a Docker host, a real Keycloak, or the VPN-only Squash are done and green
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

### Also done since
- `docs/development.md` (developer guide), README status refreshed, `tmp/` ignored.
- Checked without Docker: all Compose files parse and every referenced Dockerfile and mounted file exists (the full stack also expects `./certs`, created on the target host); `api`, `worker` and `runner-launcher` start from the same `pnpm deploy --prod` layout the Dockerfiles use (the runner launcher answers `/healthz` and rejects a missing token).

## What is left for Phase 1 sign-off (all need the user)

| # | Item | Who | Done when |
|---|------|-----|-----------|
| 1 | Run the local Docker trial stack (checklist below) | user | Login works for the four trial users with the expected menus, and `api` is healthy |
| 2 | GitHub CI check | user | The latest run on `cursor/phase1-foundation-2990` is green (new steps: Squid install, OpenBao container) |
| 3 | Rotate the GitHub token that was pasted in chat | user | Old token revoked; a new one is given to the agent only when a push is needed, never stored |
| 4 | SquashTM READ-only token plus VPN probe | user | `tools/squash-probe` run from the VPN machine; `squash-report.json` shared. Does not block any code, but it is the first step of Phase 2 and the Squash adapter is only trusted against the mock until then |

Once 1 to 3 pass (and 4 is shared or consciously postponed), the agent: fixes anything the Docker run exposes, ticks this table, and reports Phase 1 closed.

Not blocking sign-off, tracked for the target Ubuntu host: run the full `deploy/compose/docker-compose.yml` core profile with `scripts/install.sh` (OpenBao init and unseal, Keycloak client secret, TLS certificates), build the `runner-launcher` image and launch a trivial digest-pinned image through it, then check the hardening with `docker inspect`. The local trial stack covers login, sessions and role mapping on real Keycloak; OpenBao policies and the egress proxy are already proven against the real programs.

## Docker checklist for your machine (the local trial)

1. Install and start Docker Desktop (Windows, macOS) or Docker Engine (Linux). Check: `docker --version` prints a version.
2. Get the code: `git clone https://github.com/dsennathpathiraja-prog/QA-Automation.git`, then `cd QA-Automation`, then `git checkout cursor/phase1-foundation-2990` (run the next commands from this folder, the one that contains `deploy`).
3. Start it: `docker compose -f deploy/compose/local/docker-compose.local.yml up --build`. The first run takes several minutes (it builds three images and downloads Postgres and Keycloak). Leave this window open.
4. When the messages stop scrolling, open http://localhost:8080 in a browser. You should be sent to a Keycloak sign-in page.
5. Sign in as `trial-lead` with password `Trial-Pass-1`. You should land on the Dashboard with a menu on the left.
6. Sign out, then try `trial-admin` (Administrator: the menu also shows Identity mapping and AI Models) and `trial-user` (Business User: a shorter menu, no Identity mapping or AI Models). Password for all four: `Trial-Pass-1`. Others: `trial-engineer`.
7. In a second terminal run: `docker compose -f deploy/compose/local/docker-compose.local.yml ps`. Healthy looks like: `api` shows "healthy", `worker` and `web` and `postgres` and `keycloak` show "running".
8. Stop when finished: `docker compose -f deploy/compose/local/docker-compose.local.yml down` (add `-v` to also delete the trial database).

Healthy result: steps 4 to 7 behave as described.

If anything goes wrong, send back:
- the output of `docker compose -f deploy/compose/local/docker-compose.local.yml ps`
- the output of `docker compose -f deploy/compose/local/docker-compose.local.yml logs --no-color api keycloak web worker` (passwords are not printed)
- a screenshot of what the browser shows, and which step number failed
- on Windows, whether you used PowerShell or Command Prompt, and whether Docker Desktop is using WSL 2

Common first-run snags: port 8080 already in use (close the other program, or tell the agent and the port will be changed); Docker Desktop still starting (wait until it says it is running); a very slow first build (let it finish).

## Deferred by design (not Phase 1 work)
- **S3 object store adapter:** the roadmap says "S3 adapter in Phase 2+ if chosen"; `local-fs` is the Phase 1 adapter. Decide with the Q16 host sizing answer.
- **Kubernetes runner adapter** (Job + NetworkPolicy, Helm): Phase 11.
- **Worker wiring of `RemoteRunnerLauncher`** and a real runner image: Phase 5.
- **Workflow engine tables and engine:** Phase 3.

## Known limits to remember
- Per-run host allowlists are passed to the runner (`QA_ALLOWED_HOSTS`) and enforced by it; the Squid list is global.
- The runner launcher holds the container socket and is root-equivalent on the host. Keep it off user-facing networks; consider a rootless engine or socket proxy before production.
- OpenBao listener runs without TLS on the internal network (tracked hardening item).
- OpenTelemetry export has been tested against a local OTLP receiver only, not a real backend.
- The local trial stack uses fixed throw-away passwords; never expose it beyond localhost.

## How to resume
1. `git checkout cursor/phase1-foundation-2990 && git pull`
2. `pnpm install && pnpm check` (see `docs/development.md` for the optional OpenBao, Squid and Postgres tests).
3. Ask the user for the results of table items 1 to 3, then fix what they show.
