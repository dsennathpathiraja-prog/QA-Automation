# ADR 0009: LLM access: local first, one gateway, data-class gate

Status: accepted (Phase 1)

## Context

Source code, stories, screenshots and test data must stay in the organisation's network by default, and different agents need different models.

## Decision

A provider-neutral `LlmPort` with Ollama and OpenAI-compatible adapters, and an `LlmGateway` in front of every call. The gateway resolves the per-agent assignment, checks the provider is enabled and approved (and not external in the air-gapped profile), checks model requirements, refuses data classes a provider is not cleared for (tool output without a class is refused), redacts secrets, fences untrusted content, limits concurrency, applies timeouts, never falls back from local to external unless explicitly allowed, and audits every call without storing the text. External providers are off until two Administrators approve.

## Consequences

Agents cannot reach a model except through these checks. Local models are weaker at tool calling and strict JSON, so the gateway adds one repair attempt and the platform will qualify models per agent (Phase 5).

## Evidence

`packages/llm`, `packages/infrastructure/src/llm`, `tools/llm-smoke` (real Ollama run).
