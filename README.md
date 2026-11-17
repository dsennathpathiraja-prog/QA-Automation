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
| Fake providers, test harness, provider contract kit | `packages/testing` |
| API shell: health, `/api/v1/me`, route guard that refuses undeclared routes | `apps/api` |
| Architecture tests (import graph, IO rules, no git-write libraries) | `tools/architecture-tests` |
| Compose stack, nginx, Squid egress proxy, OpenBao policies and installer, Keycloak realm (authored, not run) | `deploy/compose` |

Not yet implemented in Phase 1: Keycloak OIDC session resolver (API refuses to start in production without it),
Drizzle/Postgres persistence and migrations, web app shell, Ollama adapter (`LlmPort`/`LlmGateway`), runner launcher,
object-store S3 adapter, OpenTelemetry, ADRs.

## Commands

```
pnpm install
pnpm check        # typecheck + all tests (including architecture rules)
```
