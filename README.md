# QA Platform

Connector-first, local-first agentic QA automation platform. Design: see the architecture documents
(`architecture-and-roadmap.md`, `architecture/platform-decisions.md`).

## Status: Phase 1, increment 1

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
| Architecture tests (import graph, IO rules, no git-write libraries) | `tools/architecture-tests` |
| Compose stack, nginx, Squid egress proxy, OpenBao policies and installer, Keycloak realm (authored, not run) | `deploy/compose` |

Not yet implemented in Phase 1: OIDC has only been tested against a fake IdP (never against a real Keycloak), role changes apply at next login (user is re-provisioned and audited at every login), the baseline schema covers identity, connectors, environments, audit and sessions only (workflow, execution, QA-asset, agent and LLM tables arrive with their phases),
web app shell, Ollama adapter (`LlmPort`/`LlmGateway`), runner launcher,
object-store S3 adapter, OpenTelemetry, ADRs.

## Commands

```
pnpm install
pnpm check              # typecheck + all tests (in-process Postgres via PGlite; architecture rules)
pnpm test:integration   # same invariants against a real Postgres 16 (TEST_DATABASE_URL; defaults to local qa_test)
pnpm db:generate        # drizzle-kit: new migration from schema.ts (never edit a released migration)
```
