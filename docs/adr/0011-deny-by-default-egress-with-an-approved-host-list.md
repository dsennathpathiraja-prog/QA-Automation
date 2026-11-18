# ADR 0011: Deny-by-default egress with an approved-host list

Status: accepted (Phase 1)

## Context

Data must not leave the approved network by accident, and servers must not be tricked into calling internal or unintended addresses.

## Decision

Every outbound call goes through one hardened HTTP client: approved hosts only, SSRF and DNS-rebinding protection (the connection is pinned to the address that was checked), method allowlists per connector, no cross-host redirects. A Squid proxy enforces the same list at the network edge, generated from the Administrator-managed list, and refuses address literals outright (dstdomain would otherwise fall back to a reverse DNS lookup for them). Deployment profiles are `standard`, `restricted` and `airgapped`; in air-gapped mode the list is empty and external model providers and telemetry export are refused.

## Consequences

A mistake in one layer is caught by the other. The two lists must stay in sync, so the proxy file is generated, not hand-edited.

## Evidence

`packages/infrastructure/src/http` tests, `packages/infrastructure/test/egress-proxy.integration.test.ts` (real Squid with the repository configuration).
