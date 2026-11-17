# ADR 0005: Hexagonal packages on plain Fastify, not NestJS

Status: accepted (Phase 1)

## Context

The roadmap proposed NestJS for its modules, dependency injection and guards. The layered design already comes from package boundaries, and the guards we need are small.

## Decision

Plain Fastify for HTTP. Business rules live in framework-free packages (`domain`, `security`, `connector-sdk`, `llm`). Each deployable has one composition root (`apps/*/src/server.ts` or `main.ts`) that is the only place allowed to import infrastructure and persistence. Route protection is a declared access rule on every route; a route with none is refused at startup.

## Consequences

Less framework and less magic, and a hard rule instead of a convention for where wiring happens. We give up NestJS conventions and generators; new contributors learn the package rules instead.

## Evidence

`apps/api/src/app.ts` (route guard), architecture tests for composition roots.
