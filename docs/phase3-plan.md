# Phase 3 plan: environment management

Started Nov 18, 2026, after the Phase 2 sign-off. Scope is the roadmap Phase 3 (Environment management), not the workflow engine. The engine is Phase 4 and is noted in [`phase4-plan.md`](phase4-plan.md).

## Status (Nov 18, 2026)
Phase 3 is signed off by the user. A QA environment showed as selectable, an application host was approved and accepted, and the remaining checks (the other tabs, a password that stays hidden, a connector, Check this environment, production authorization, and a view-only QA engineer) were reported working. Slice 7, the connectivity check, is the first part of Phase 5. See [`phase5-plan.md`](phase5-plan.md).

Slices 1 to 6 are in this branch: environment records, authentication and test data with write-only secrets, connector references, production authorization, validation, and the Environments page.

## What the roadmap asks for
Environments a person can configure: kind, application URL, browser settings, test data, authentication, connector references, and execution restrictions. Credentials are write-only. A production environment cannot be selected until an Administrator has an active authorization for it. Validation errors name what to fix. A resolver later turns a saved environment into a `ResolvedEnvironment` for a run.

The tables already exist from the Phase 1 baseline: `environment`, `environment_connector_ref`, `auth_profile`, `test_data_profile`, `environment_authorization`.

## Acceptance
A person can configure an environment from the UI (acceptance criterion 3). A secret value is never returned. Production is unselectable without an active authorization. Each validation error says what is wrong and what to change.

## Slices
1. **Environment records.** Create, list, read, update, disable, and remove. Kind, application URL, browser settings, and execution restrictions. The application host must already be on the approved-host list for purpose `application`. A production environment is stored but not selectable. No authentication secrets in this slice.
2. **Authentication and test data.** Auth profiles (none, basic, form login, bearer, saved browser session) and test data profiles. Secret values are stored and never read back by the API.
3. **Connector references.** Attach enabled connectors to an environment by role.
4. **Production authorization.** An Administrator records a justification and a validity window. One active authorization per production environment. Expired or revoked authorizations make production unselectable again.
5. **Resolver and validation.** `ResolvedEnvironment` for a later run, and a validation call the workflow builder will use. Errors stay specific.
6. **Environments UI.** List, create, and the edit tabs (General, Browser, Test data, Authentication, Connectors, Restrictions), including the production authorization dialog.
7. **Connectivity check.** Reachability of the application URL, reported on the environment. Phase 5 places this check. The worker asks the application address through the approved-host list and records the answer.

## Not in Phase 3
The workflow engine, the visual builder, and starting a run. Those are Phase 4.
