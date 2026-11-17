# ADR 0003: Zod as the contract language

Status: accepted (Phase 1)

## Context

API payloads, capability inputs and outputs, workflow definitions and LLM structured outputs all need one validated shape that the UI, API and engine agree on.

## Decision

Zod schemas in `@qa/contracts` (API) and in the capability catalog (connectors). JSON Schema is derived from Zod where another system needs it (for example constrained decoding in the LLM gateway, via `fromZod`).

## Consequences

One source of truth, validated at runtime at every boundary. Runtime cost is small at this scale. OpenAPI generation from the same schemas is possible later.

## Evidence

`packages/contracts`, `packages/connector-sdk/src/catalog.ts`, `packages/llm/src/zod-schema.ts`.
