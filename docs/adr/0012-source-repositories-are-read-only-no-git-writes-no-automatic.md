# ADR 0012: Source repositories are read-only; no git writes; healer is platform-workspace only

Status: accepted (Phase 1); amended 21 Nov 2026 for `playwright-test-healer`

## Context

The specification forbids writing to source repositories, committing or pushing. An earlier reading also banned any “healer” agent. Product case prep now needs `playwright-test-healer` to repair broken **generated** Playwright stubs after `playwright-test-generator`, without touching connected application repos.

## Decision

1. **Source repositories stay read-only.** The `source-repo` capability category cannot declare a write capability (registration fails), the connector manager denies writes on read-only instances, and no git or hosting write library may be imported anywhere (architecture test).
2. **Generated test code lives in a platform-owned workspace**, never in a connected repository.
3. **`playwright-test-healer` is allowed** solely to rewrite those platform-owned generated test files (and matching in-memory case payloads before publish). It must not commit, push, open PRs, or edit files retrieved from a source-repo connector.
4. Healing application source, production config, or Squash-owned scripts outside the generated stub payload is out of scope.

## Consequences

Requirements about repository immutability hold. Adding repository writes would still require changing the rules and this record. Operators can enable healer as a mandatory RV step without weakening SCM read-only guarantees.

## Evidence

`packages/connector-sdk/test/catalog.test.ts`, architecture tests (`isGitWrite`), `packages/agents/src/healer.ts`, workflow step `rv.heal-tests`.
