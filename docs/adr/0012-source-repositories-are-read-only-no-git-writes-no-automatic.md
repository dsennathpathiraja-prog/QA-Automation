# ADR 0012: Source repositories are read-only; no git writes; no automatic test healing

Status: accepted (Phase 1)

## Context

The specification forbids writing to source repositories, committing or pushing, and automatically repairing tests.

## Decision

There is no vocabulary for these: the `source-repo` capability category cannot declare a write capability (registration fails), the connector manager denies writes on read-only instances, no git or hosting write library may be imported anywhere (architecture test), and no healer agent can be registered. Generated test code lives in a platform-owned workspace, never in a connected repository.

## Consequences

Requirements hold even if a single check has a bug. Adding such a feature later would require changing the rules and this record, not slipping it in.

## Evidence

`packages/connector-sdk/test/catalog.test.ts`, architecture tests (`isGitWrite`).
