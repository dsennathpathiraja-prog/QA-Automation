# ADR 0010: Runner isolation: RunnerLauncher port and a separate launcher service

Status: accepted (Phase 1)

## Context

Generated tests run browsers against real environments. Giving the worker the container socket would make a compromised worker root on the host.

## Decision

Runners are ephemeral containers started through a `RunnerLauncher` port. The worker talks to a separate `runner-launcher` service with a short bearer token. That service is the only holder of the container engine socket; it validates every request (image pinned by digest and from an approved registry, bounded CPU, memory, processes and time, explicit host allowlist), applies fixed hardening (no privileges, all capabilities dropped, read-only root filesystem, no mounts), refuses to touch containers it did not create, stops runners that exceed their time limit, and limits how many run at once. The Kubernetes adapter (Job plus NetworkPolicy) follows in Phase 11.

## Consequences

A compromised worker can request only constrained runners. The launcher itself is still powerful: keep it off user-facing networks, and prefer a rootless engine or a socket proxy. The per-run host allowlist is passed to the runner and enforced by it; the proxy enforces the global approved-host list.

## Evidence

`packages/domain/src/runner.ts` and `container-engine.ts`, `apps/runner-launcher`, `packages/infrastructure/src/runner` (tested against a Docker API double on a real unix socket).
