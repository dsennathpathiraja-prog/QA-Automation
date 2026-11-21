# Development guide

## Prerequisites
- Node.js 22 or newer, and pnpm 9 (`corepack enable` is enough).
- Docker is optional for development. It is needed only to run the Compose stacks.
- Optional, for the extra integration tests: an OpenBao binary and Squid (see below). Tests that need them are skipped when absent.

## First run
```
pnpm install
pnpm check        # type-check every package, then run all tests
```
`pnpm check` needs no database or network: the persistence tests run Postgres in-process (PGlite).

## Repository map
| Path | What it is |
|------|------------|
| `apps/api` | HTTP API (Fastify): login, sessions, route permissions |
| `apps/worker` | Background worker (loop, health endpoints) |
| `apps/runner-launcher` | Service that starts hardened test-runner containers |
| `apps/web` | Web app (React, Vite) |
| `packages/domain`, `contracts`, `security`, `connector-sdk`, `llm`, `telemetry`, `agents` | Framework-free core: rules, ports, connector manager, model gateway, planner/generator/healer/browser agent ports |
| `docs/requirement-validation-case-workflow.md` | Durable explore → plan MD → generate many → heal → publish workflow |
| `docs/playwright-agents-mcp.md` | Enable Ollama / Playwright browser / local Cursor MCP for requirement-validation case prep |
| `packages/infrastructure`, `persistence` | The adapters: OpenBao, OIDC, HTTP client, Squash, Ollama, Docker, Postgres |
| `packages/testing` | Fakes, mocks and contract-test kits |
| `tools/architecture-tests` | Layer rules and the credential scan; they run with every test run |
| `deploy/compose` | Compose stacks: `local/` for a quick trial, the parent folder for a real host |
| `docs/adr` | Architecture decisions |

Which package may import which is enforced by `tools/architecture-tests`. If you add a package or a dependency between packages, update the allowed list in `tools/architecture-tests/src/analyzer.ts`; the test tells you what it refuses and why.

## Everyday commands
```
pnpm check                  # typecheck + all tests
pnpm test                   # tests only
pnpm lint:arch              # architecture rules and credential scan only
pnpm test:integration       # persistence invariants on a real Postgres 16
pnpm db:generate            # new migration from packages/persistence/src/schema.ts
pnpm --filter @qa/web dev   # web app on http://localhost:5173
pnpm --filter @qa/api start # API on :3000 (dev mode: sign in with DEV_USER / DEV_GROUPS headers)
```
Released migrations are never edited. A change to the schema is a new migration file; the migration runner refuses to start if an applied file changed.

## Optional integration tests
These run the repository's real configuration against real software. They skip themselves when the software is missing, and CI installs both.

**Real Postgres** (`pnpm test:integration`): a Postgres 16 reachable at `TEST_DATABASE_URL` (default `postgres://qa_test:qa_test@127.0.0.1:5432/postgres`).

**Real OpenBao** (secret policies; the API must not be able to read secrets back):
```
bao server -dev -dev-root-token-id=root-test            # in one terminal
TEST_OPENBAO_ADDR=http://127.0.0.1:8200 pnpm test        # in another
```

**Real Squid** (egress proxy blocks hosts that are not approved): install `squid` (for example `sudo apt-get install squid`); the test starts and stops its own instance on a free port.

**Real Ollama** (model gateway smoke): `OLLAMA_MODEL=<model> pnpm --filter @qa/llm-smoke smoke`.

## Running the stacks
- **Quick trial on one machine:** `deploy/compose/local/README.md`.
- **A real host (OpenBao, egress proxy, TLS certificates):** `deploy/compose/README.md`. Services without a profile are the core stack. Optional profiles: `llm` (Ollama; add `-f docker-compose.gpu.yml` for a GPU), `s3` (S3-compatible object store), `runners` (runner launcher), `obs` (OpenTelemetry collector).
- **Telemetry:** nothing is exported unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set to an approved internal host. Spans carry names, outcomes and counts, never data.

## Rules that are easy to trip over
- No credentials in the repository. The scan fails the test run; use Docker secret files or OpenBao references. The one exception is the local trial stack, which uses fixed throw-away passwords.
- Only the composition roots (`apps/*/src/server.ts`, `apps/*/src/main.ts`) may import `@qa/infrastructure` and `@qa/persistence`.
- `api`, `web`, `agents` and other upper layers must never call `.lease()` on a secret store.
- Do not add git or repository-hosting write libraries anywhere; the architecture test refuses them.
- Squash stores generated test cases (owner request, 19 Nov 2026). The connector is read and write and uses a READ_WRITE token. Source repositories stay read-only.
