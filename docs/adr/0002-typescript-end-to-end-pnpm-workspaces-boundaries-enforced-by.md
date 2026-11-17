# ADR 0002: TypeScript end to end, pnpm workspaces, boundaries enforced by tests

Status: accepted (Phase 1)

## Context

Playwright, the Playwright MCP server, the MCP SDK and the UI are all JavaScript native. One language means one shared contracts package and no duplicated schemas.

## Decision

Node 22 and TypeScript everywhere, in a pnpm workspace. The roadmap proposed Turborepo and dependency-cruiser; we use plain pnpm scripts and an AST-based architecture test built on the TypeScript compiler, because that checks exactly the rules we care about (allowed dependencies per package, which layers may do network or file IO, no git-write libraries, who may call `lease()`) with no extra tool. Turborepo can be added when build times justify it.

## Consequences

Layering is checked on every test run and in CI, so erosion fails the build. The rules live in one file and are tested with self-tests that prove each rule fires.

## Evidence

`tools/architecture-tests/src/analyzer.ts`, `architecture.test.ts`, `secret-scan.test.ts`.
