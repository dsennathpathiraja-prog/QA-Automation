# Phase 2 plan: connector management UI and backend

Started Nov 18, 2026. Scope and acceptance come from the roadmap (Phase 2). This file says how we slice it and what is blocked on what.

## Decisions taken
- The current Squash instance was connected live on Nov 18, 2026. It stays read-only (D20, ADR 0013): use a READ token. Publishing test cases and pushing results is for a separate writable connector (READ_WRITE token, dedicated service user, explicit enablement) and stays in preview against this instance. The capability matrix remains `docs/architecture/squash-rest-api-15.0.4-catalog.md`.

## What we already have for Phase 2
Connector Execution Manager with the full policy pipeline, capability registry, secret store ports, hardened HTTP client, a Squash read provider, a stub work-item provider, the provider contract-test kit, the `connector_instance` and operation-log tables, role-aware web shell with a Connectors page (empty state).

## Status (Nov 18, 2026)
Phase 2 is signed off by the user. GitHub, Azure Boards, approved hosts, and the current Squash instance (read-only, D20) were exercised live. Azure DevOps Repos and Jira remain labelled "not verified against a live instance". The managed browser was not started. CI covered the code with recorded responses.

- Slices 1 and 2: connector instances, wizard, Test Connection on the worker, capability table, operation log, approved hosts. Providers include SquashTM (the current instance is connected live and kept read-only) and the offline "Sample work items (demo)" provider.
- Slice 3: GitHub (live-capable) and Azure DevOps Repos (recorded responses, labelled in the UI). A token that can push is refused and the connector cannot be switched on. The six read-only checks are on the connector page: read-only record, no write capability, GET only, token scope, approved host, no git write path.
- Slice 4: Azure Boards (live-capable, acceptance criteria from the Acceptance Criteria field) and Jira (recorded responses, acceptance criteria from the description, with an optional field name).
- Slice 5: managed Playwright server (`--profile browser`, address `http://playwright-mcp:8931`). The browser may open only the addresses listed on the connector. MFA is a saved browser session a person captures once; the platform does not enter the code. The worker re-tests enabled connectors on a schedule (`CONNECTOR_HEALTH_MS`, default 15 minutes). Approved hosts is the list that blocks unexpected addresses.
- Opt-in live checks, not run in CI: GitHub needs `GITHUB_LIVE_TOKEN` and `GITHUB_LIVE_ORG` (optional `GITHUB_LIVE_REPO`, `GITHUB_LIVE_API`). Azure Boards needs `AZURE_BOARDS_LIVE_TOKEN`, `AZURE_BOARDS_LIVE_ORG` and `AZURE_BOARDS_LIVE_PROJECT` (optional `AZURE_BOARDS_LIVE_API`).
- Credentials: the API can store and delete, never read. The worker reads them to run tests. Local trial uses an encrypted-in-database store with a throw-away key; the core Compose stack uses OpenBao AppRole credentials per service (run `deploy/compose/scripts/install.sh` again to create the worker credentials).

## Slices (each ends with something a person can use)
1. **Connector instances backend and list/detail UI (no real providers needed).** API: create, read, update, enable/disable, disconnect, list; secret values accepted once and written to the secret store, never returned; operation log viewer for administrators. Web: list with status, detail with capabilities and last successful connection. Uses the stub provider and the Squash mock. Acceptance covered: disabled instance cannot be used by the manager; canary test that no secret value appears in any API response or log.
2. **Wizard framework and Test Connection.** Provider descriptors drive the form (fields, secret fields, scope, help text); Test Connection runs capability probing and permission inspection through the manager; the result is a per-capability supported / partial / unsupported table. Squash is the first provider shown (mock-backed).
3. **GitHub and Azure DevOps Repos with the read-only gate.** Wizard blocks a credential that carries write permission; the six read-only layers are visible in the UI; provider fixtures plus opt-in live tests.
4. **Jira and Azure Boards.** Work-item providers with configurable acceptance-criteria mapping.
5. **Playwright Browser MCP and the managed runner seed**, health-check scheduler in the worker, SSRF allowlist admin setting.
6. **Phase 2 acceptance pass:** the criteria in the roadmap, per provider, through the UI.

Slices 1 and 2 need nothing from outside. Slices 3 to 5 need answers below, and ideally sandbox accounts for live opt-in tests (fixtures-only is possible if none exist).

## Answers from the user (Nov 18, 2026)
1. **Reachable for testing:** GitHub and Azure Boards. Azure DevOps Repos and Jira are not reachable, so those two connectors are built against recorded fixtures only and are marked "not verified against a live instance" until someone can run the opt-in live tests. GitHub and Azure Boards get opt-in live tests as soon as sandbox credentials exist.
2. **Jira acceptance criteria:** in the description. The extractor reads the description by default; a custom-field mapping stays configurable for later.
3. **Playwright MCP:** the platform manages it (managed container, health-checked by the worker).
4. **Applications under test:** plain username and password login, or a saved browser session. MFA is handled through a saved browser session captured once by a person; the platform never automates the MFA prompt itself.

Effect on slices: slice 3 builds GitHub live-capable and Azure DevOps Repos fixture-only; slice 4 builds Azure Boards live-capable and Jira fixture-only with description-based acceptance criteria; slice 5 builds the managed Playwright MCP with saved-session support.
