# ADR 0013: The target SquashTM is read-only for the platform

Status: accepted (Phase 1)

## Context

The owner of the Squash instance asked that no test case or detail in it is added or modified.

## Decision

The Squash connector instance is created read-only. The adapter sends only GET requests with a personal API token (READ permission recommended), the HTTP client for it allows only GET, the manager denies write capabilities before any request, and discovery uses read calls only. Write paths are built and tested against a mock generated from the vendor documentation. Lifting the restriction needs an explicit Administrator action recorded in the audit log and the owner's written approval.

## Consequences

Workflows that would write to Squash run in preview mode against this instance. Basic authentication is not used: the instance disables it, and the vendor is removing it.

## Evidence

`packages/infrastructure/src/connectors/squash`, `packages/testing/src/squash-mock.ts` and its tests (no request other than GET is ever sent).
