# Phase 2 plan: connector management UI and backend

Started Nov 18, 2026. Scope and acceptance come from the roadmap (Phase 2). This file says how we slice it and what is blocked on what.

## Decisions taken
- The Squash live check is **postponed** (no access). The Squash connector is built and tested against the documentation-based mock; `docs/architecture/squash-rest-api-15.0.4-catalog.md` serves as the capability matrix until a live run exists. Every Squash screen says "not verified against a live instance" until then.
- The Squash instance stays strictly read-only (ADR 0013).

## What we already have for Phase 2
Connector Execution Manager with the full policy pipeline, capability registry, secret store ports, hardened HTTP client, a Squash read provider, a stub work-item provider, the provider contract-test kit, the `connector_instance` and operation-log tables, role-aware web shell with a Connectors page (empty state).

## Slices (each ends with something a person can use)
1. **Connector instances backend and list/detail UI (no real providers needed).** API: create, read, update, enable/disable, disconnect, list; secret values accepted once and written to the secret store, never returned; operation log viewer for administrators. Web: list with status, detail with capabilities and last successful connection. Uses the stub provider and the Squash mock. Acceptance covered: disabled instance cannot be used by the manager; canary test that no secret value appears in any API response or log.
2. **Wizard framework and Test Connection.** Provider descriptors drive the form (fields, secret fields, scope, help text); Test Connection runs capability probing and permission inspection through the manager; the result is a per-capability supported / partial / unsupported table. Squash is the first provider shown (mock-backed).
3. **GitHub and Azure DevOps Repos with the read-only gate.** Wizard blocks a credential that carries write permission; the six read-only layers are visible in the UI; provider fixtures plus opt-in live tests.
4. **Jira and Azure Boards.** Work-item providers with configurable acceptance-criteria mapping.
5. **Playwright Browser MCP and the managed runner seed**, health-check scheduler in the worker, SSRF allowlist admin setting.
6. **Phase 2 acceptance pass:** the criteria in the roadmap, per provider, through the UI.

Slices 1 and 2 need nothing from outside. Slices 3 to 5 need answers below, and ideally sandbox accounts for live opt-in tests (fixtures-only is possible if none exist).

## Questions for the user (defaults apply if unanswered)
1. **Which systems can you reach for testing?** GitHub (github.com or Enterprise), Azure DevOps (Services or Server), Jira (Cloud or Data Center), Azure Boards. Default: build all four against recorded fixtures only, no live tests.
2. **Where do acceptance criteria live in Jira?** Description text or a custom field. Default: configurable per connector, description by default.
3. **Playwright MCP:** do you already run a Playwright MCP server, or should the platform manage one? Default: platform-managed.
4. **Applications under test:** form login or SSO/MFA? Default: form login or saved browser state; SSO/MFA flows are out of scope for Phase 2.
