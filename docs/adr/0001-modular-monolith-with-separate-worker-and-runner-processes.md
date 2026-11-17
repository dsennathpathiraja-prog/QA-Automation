# ADR 0001: Modular monolith with separate worker and runner processes

Status: accepted (Phase 1)

## Context

The platform has an interactive side (API, web) and long-running work (workflows, agents, test execution). Splitting into many services would add operating cost the team does not need yet.

## Decision

One codebase, three kinds of process: `api` (stateless, answers users), `worker` (owns scheduling, the Connector Execution Manager and agents), and short-lived `runner` containers (run generated tests). Packages talk through ports (interfaces), so any layer can be moved into its own service later.

## Consequences

The API never runs workflows itself. Workers and API scale independently and share only Postgres and the object store. A bug in one package cannot silently reach into another, because the architecture tests refuse such imports.

## Evidence

`tools/architecture-tests` (layer and IO rules), `apps/api`, `apps/worker`, `apps/runner-launcher`.
