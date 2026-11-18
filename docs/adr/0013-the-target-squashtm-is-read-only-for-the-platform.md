# ADR 0013: The current SquashTM instance is read-only (D20)

Status: accepted (Phase 1)

## Context

The owner of the current Squash instance asked that no test case or detail in it is added or modified (decision D20). That constraint is on this instance. It is not a rule that the platform never writes to Squash.

The requirements call for publishing test cases and pushing execution results and evidence to Squash (`rv.publish-testcases`, `rv.sync-results`, `rg.update-squash`) on a writable instance.

## Decision

The connector pointed at this Squash is created read-only and uses a READ token. Against this instance the adapter sends only GET requests, and the steps that would publish test cases or push results run in preview mode.

A real sync uses a separate connector instance: a writable Squash (a sandbox or an approved project), a READ_WRITE token, a dedicated service user, and an explicit enablement recorded in the audit log. The write path is designed and covered by the documentation-based mock. Those writes are not sent to this instance.

Basic authentication is not used: this instance disables it, and the vendor is removing it.

## Consequences

A READ_WRITE token on this read-only connector is tolerated and reported as a warning, because the instance still refuses writes. The recommended token for this instance is READ. Switching on writes here still needs the owner's approval and the separate writable connector above.

## Evidence

`packages/infrastructure/src/connectors/squash`, `packages/testing/src/squash-mock.ts` and its tests. Tests of this instance prove that no request other than GET is sent to it.
