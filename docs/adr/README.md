# Architecture decision records

Each record states the decision as built in the repository, with the evidence (tests or code) that backs it. Where the build differs from the Phase 0 design, the record says so.

| # | Decision | Status |
|---|----------|--------|
| 0001 | [Modular monolith with separate worker and runner processes](0001-modular-monolith-with-separate-worker-and-runner-processes.md) | accepted |
| 0002 | [TypeScript end to end, pnpm workspaces, boundaries enforced by tests](0002-typescript-end-to-end-pnpm-workspaces-boundaries-enforced-by.md) | accepted |
| 0003 | [Zod as the contract language](0003-zod-as-the-contract-language.md) | accepted |
| 0004 | [Custom durable workflow engine on PostgreSQL, behind a port](0004-custom-durable-workflow-engine-on-postgresql-behind-a-port.md) | accepted |
| 0005 | [Hexagonal packages on plain Fastify, not NestJS](0005-hexagonal-packages-on-plain-fastify-not-nestjs.md) | accepted |
| 0006 | [Connector-first: capabilities and a single Connector Execution Manager](0006-connector-first-capabilities-and-a-single-connector-executio.md) | accepted |
| 0007 | [Secrets in OpenBao behind a SecretStore port; the API can write but never read](0007-secrets-in-openbao-behind-a-secretstore-port-the-api-can-wri.md) | accepted |
| 0008 | [Identity: OIDC through Keycloak, server-side sessions, IdP groups mapped to four roles](0008-identity-oidc-through-keycloak-server-side-sessions-idp-grou.md) | accepted |
| 0009 | [LLM access: local first, one gateway, data-class gate](0009-llm-access-local-first-one-gateway-data-class-gate.md) | accepted |
| 0010 | [Runner isolation: RunnerLauncher port and a separate launcher service](0010-runner-isolation-runnerlauncher-port-and-a-separate-launcher.md) | accepted |
| 0011 | [Deny-by-default egress with an approved-host list](0011-deny-by-default-egress-with-an-approved-host-list.md) | accepted |
| 0012 | [Source repositories are read-only; no git writes; no automatic test healing](0012-source-repositories-are-read-only-no-git-writes-no-automatic.md) | accepted |
| 0013 | [The target SquashTM is read-only for the platform](0013-the-target-squashtm-is-read-only-for-the-platform.md) | accepted |
| 0014 | [Persistence: Drizzle with reviewed SQL migrations, append-only audit](0014-persistence-drizzle-with-reviewed-sql-migrations-append-only.md) | accepted |
| 0015 | [Observability: OpenTelemetry, with no payload data](0015-observability-opentelemetry-with-no-payload-data.md) | accepted |
