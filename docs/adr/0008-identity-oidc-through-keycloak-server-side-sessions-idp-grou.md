# ADR 0008: Identity: OIDC through Keycloak, server-side sessions, IdP groups mapped to four roles

Status: accepted (Phase 1)

## Context

The organisation may use Entra ID or another provider, and authorization must not depend on one provider.

## Decision

The API is a backend-for-frontend: authorization code flow with PKCE, state and nonce, ID token verified with the provider's keys, and a server-side session in Postgres (token stored hashed, idle and absolute timeouts, CSRF header, back-channel logout). Keycloak is deployed by default and can broker Entra ID. IdP group names map to the four internal roles (a user in several groups gets the union); a user in none cannot sign in. All permission checks happen in the backend through one `PolicyEngine`.

## Consequences

The browser never holds tokens. Changing identity provider means changing configuration, not code. Role changes apply at the next login.

## Evidence

`packages/infrastructure/src/identity`, `apps/api/src/auth.ts`, `packages/security`. Tested against a fake provider; the real Keycloak run is the local trial stack.
