# QA Platform

Connector-first, local-first agentic QA automation platform. Design: see the architecture documents
(`architecture-and-roadmap.md`, `architecture/platform-decisions.md`).

## Status: Phase 6 started

Phases 1, 2, 3, 4, and 5 are done. Phase 4 covers workflow drafts, the step validator, publish and approval, the worker engine, and the builder. On 18 Nov 2026 the user approved a workflow and run 1436518e succeeded through all 10 steps. The run records the steps. Reading the story, driving the browser, and creating test cases in Squash are later. The plan is in [`docs/phase4-plan.md`](docs/phase4-plan.md).

Phase 5 places the reachability check in a runner when the local runners profile is up. On 19 Nov 2026 the page showed "The runner finished. The application answered 200." Without that profile the worker still checks the address itself, and earlier the same day that check showed "The application answered 200." Workflow steps still do not run a test suite. The plan is in [`docs/phase5-plan.md`](docs/phase5-plan.md).

Phase 6 is the Executions and Test Cases screens. Executions now lists runs that have already been started. Test Cases is still a placeholder and will be a library in this platform, not a write into the current Squash. The plan is in [`docs/phase6-plan.md`](docs/phase6-plan.md).

Connectors can be added from the UI (GitHub, Azure DevOps Repos, Jira, Azure Boards, Squash, the managed Playwright server, and an offline demo). GitHub, Azure Boards, and the current Squash instance have been used live. Azure DevOps Repos and Jira remain labelled "not verified against a live instance" until someone runs them against a reachable server. What is in each slice is in [`docs/phase2-plan.md`](docs/phase2-plan.md). Phase 1 sign-off notes remain in [`docs/phase1-status.md`](docs/phase1-status.md).

Phase 1 sign-off is in [`docs/phase1-status.md`](docs/phase1-status.md). Decisions are in [`docs/adr/`](docs/adr/README.md). How to build, test and run: [`docs/development.md`](docs/development.md).

Implemented and tested:

| Area | Where |
|------|-------|
| Domain: roles/permissions matrix, error taxonomy, ports (`SecretStore`, `ObjectStore`, `Clock`) | `packages/domain` |
| Capability catalog, provider registry (source-repo write capabilities impossible), machine policy, constraint evaluators, rate limit / circuit breaker, **Connector Execution Manager** | `packages/connector-sdk` |
| PolicyEngine (RBAC + maker-checker, two-person production rule), IdP group-to-role mapping, secret redactor, hash-chained audit log, route access metadata | `packages/security` |
| Egress policy (approved hosts, air-gapped profile, SSRF/DNS-rebinding guard), hardened HTTP client (method allowlist, GraphQL read-only guard, DNS pinning), OpenBao KV v2 adapter, DB-envelope store (dev/CI only), local-fs object store | `packages/infrastructure` |
| Postgres schema (Drizzle) + SQL migrations with tamper detection, append-only triggers, seeded roles and the four default IdP group mappings, session store (token hashed), hash-chained audit log, operation-log sink, user provisioning | `packages/persistence` |
| Fake providers, test harness, provider contract kit | `packages/testing` |
| API shell: health, `/api/v1/me`, route guard that refuses undeclared routes; **OIDC login** (auth code + PKCE, nonce/state, server-side sessions with idle/absolute timeout, CSRF header, back-channel logout, group-to-role mapping) | `apps/api`, `packages/infrastructure/src/identity` |
| Web shell (React 18, Vite, TanStack Router/Query, Tailwind): session gate with login redirect, role-aware navigation from the caller's permissions, route guard with explanations, sign-in error pages, CSRF-aware API client, accessible layout (skip link, landmarks, mobile menu). Pages: Dashboard, Connectors (empty state), Identity mapping (read-only); other screens are labelled placeholders naming their phase | `apps/web` |
| LLM gateway (assignments, data-class gate, redaction, untrusted-content fencing, concurrency slots, structured output and tool-step repair, fallback rules, audit) | `packages/llm` |
| Ollama and OpenAI-compatible (vLLM) adapters, `llm_call_log` audit sink, read-only AI Models page; real Ollama smoke: `OLLAMA_MODEL=<model> pnpm --filter @qa/llm-smoke smoke` | `packages/infrastructure/src/llm`, `packages/persistence`, `tools/llm-smoke`, `apps/web` |
| SquashTM read provider (token auth, GET only, paging, HTML to text, probe, token expiry), documentation-based Squash mock, `RunnerLauncher` port with spec validation and a fake, worker app skeleton (loop, health, graceful stop) | `packages/infrastructure/src/connectors/squash`, `packages/testing`, `packages/domain/src/runner.ts`, `apps/worker` |
| Architecture tests (import graph, IO rules, no git-write libraries) | `tools/architecture-tests` |
| Compose stack, nginx, Squid egress proxy, OpenBao policies and installer, Keycloak realm (authored, not run) | `deploy/compose` |

Also added since: OpenTelemetry (`packages/telemetry`), the runner launcher service with a Docker Engine adapter (`apps/runner-launcher`), real-OpenBao policy tests and a real-Squid egress test, and a repository scan for committed credentials.

Not yet validated (these are the sign-off checks): OIDC has only been tested against a fake IdP, never a real Keycloak; the Compose stacks and images have not been run on a Docker host. Also: role changes apply at next login (user is re-provisioned and audited at every login), the baseline schema covers identity, connectors, environments, audit and sessions only (workflow, execution, QA-asset and agent tables arrive with their phases; only `llm_call_log` exists for LLM). Deferred by design: S3 object store adapter (Phase 2+), Kubernetes runner adapter (Phase 11).

## Try it locally with Docker

`deploy/compose/local/README.md` starts the whole stack (web, API, worker, Postgres, Keycloak with four trial users) on one machine at http://localhost:8088. It has never been run by the authors; your first run is the validation (the step-by-step checklist is in `docs/phase1-status.md`).

## Squash discovery probe (read-only)

The platform host cannot resolve `squash.trafforge.local` (it is behind your VPN), so the probe is a single dependency-free script you run on a machine that can reach Squash. It sends GET requests only and prints status codes, authentication headers and field names, never data values.

```
SQUASH_BASE_URL=http://squash.trafforge.local/squash node tools/squash-probe/probe.mjs > squash-report.json
# with a read-only API token kept in a file (never on the command line):
SQUASH_BASE_URL=... SQUASH_TOKEN_FILE=./squash-token.txt node tools/squash-probe/probe.mjs > squash-report.json
```

## Commands

```
pnpm install
pnpm check              # typecheck + all tests (in-process Postgres via PGlite; architecture rules)
pnpm test:integration   # same invariants against a real Postgres 16 (TEST_DATABASE_URL; defaults to local qa_test)
pnpm --filter @qa/web dev   # SPA on :5173, proxies /api to :3000 and signs you in via dev headers (DEV_USER, DEV_GROUPS); API in dev mode: pnpm --filter @qa/api start
pnpm db:generate        # drizzle-kit: new migration from schema.ts (never edit a released migration)
```
