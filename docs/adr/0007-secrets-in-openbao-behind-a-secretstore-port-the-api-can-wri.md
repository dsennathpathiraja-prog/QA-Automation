# ADR 0007: Secrets in OpenBao behind a SecretStore port; the API can write but never read

Status: accepted (Phase 1)

## Context

Credentials must never sit in configuration files or source code, and must not be readable through the UI or API.

## Decision

A `SecretStore` port with an OpenBao adapter (default). The `api` AppRole may only create and update secret values; the `worker` AppRole reads connector secrets; the runner launcher reads only environment credentials. A DB-envelope adapter exists for local development and CI and refuses to run in production. Honest exception: the first database password and the OIDC client secret are delivered as Docker secret files, because the platform cannot read OpenBao before it can log in to anything. A repository scan fails the build on committed credentials.

## Consequences

Compromising the API does not reveal stored credentials. OpenBao adds a stateful service with an unseal procedure that operators must run.

## Evidence

`packages/infrastructure/test/openbao.integration.test.ts` runs the real policy files against a real OpenBao: the api cannot read back what it wrote; `tools/architecture-tests/src/secret-scan.test.ts`.
