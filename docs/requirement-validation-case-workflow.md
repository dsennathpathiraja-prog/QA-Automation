# Requirement-validation case prep workflow

Durable product workflow for preparing Playwright test cases from a work item (Azure Boards / Jira / pasted story). Updated after PR #14 (planner / generator / browser ports).

## Ordered stages

```
1) Read work item
2) Explore UI  (optional but at least one exploration is required)
3) Explore code (optional)
4) Consolidate findings
5) playwright-test-planner  → durable Markdown test plan artifact
6) playwright-test-generator → many Playwright cases from that MD plan
7) playwright-test-healer   → run/check stubs and fix broken platform-owned cases
8) Publish → Test Cases (+ Squash when READ_WRITE)
```

Exploration **always runs before** the planner so UI/source notes feed the plan. The generator does **not** invent a tiny 1 positive + 1 negative + 1 edge sample from scratch when a plan exists — it consumes the Markdown plan. A rich work item (Description + many acceptance criteria / paths) may produce **100+** scenarios and cases (caps: 200 scenarios, 250 generated cases).

Execution of prepared cases against an environment remains a **separate** Executions action (Phase 7). Regression stays on its own workflow and never plans or generates.

## Roles

| Stage | Platform key | What it does |
|-------|--------------|--------------|
| Explore UI | `playwright-browser` / managed `playwright-mcp` | Opens the environment URL, snapshots pages, records findings **before** planning |
| Explore code | source-repo connector (read-only) | Lists/reads matching files; never writes or commits |
| Plan | `playwright-test-planner` | Writes a solid Markdown plan (`plans/{app}/{work-item}.plan.md`) with many Positive / Negative / Edge scenarios per criterion and Description path |
| Generate | `playwright-test-generator` | Turns **every** planned scenario into a Playwright test (`.spec.js` stubs in the platform workspace) |
| Heal | `playwright-test-healer` | Checks generated cases; rewrites broken stubs **only** in the platform-owned workspace |

Local model (`OLLAMA_URL` / `VLLM_URL`) preferred for planner, generator, and healer. Without a model, description-aware heuristics still scale beyond a single triple per criterion. Cursor MCP package names and adapters: [`playwright-agents-mcp.md`](playwright-agents-mcp.md).

## Markdown plan artifact

Planner output always includes:

- `planMarkdown` — full Markdown body (Context, Acceptance criteria, Exploration findings, Scenarios)
- `planArtifact` — relative path `plans/{application}/{work-item}.plan.md`
- `scenarios` — structured array used by the engine and healer

Generator input prefers `planMarkdown` (and falls back to parsing it when the structured array is empty). Scenario sections look like:

```markdown
### 12. Negative: reject declined card
- **Kind:** negative
- **Priority:** high
- **Criterion:** The saved card is listed
- **Steps:** Open PayNSure. Attempt declined card. …
- **Expected:** The invalid path (declined card) is refused …
```

## Volume rules

- Each acceptance criterion yields **multiple** positives, negatives, and edges when the wording supports them (not a hard stop at three).
- Description body lines (beyond AC) become extra path seeds for the planner.
- Caps: **200** plan scenarios, **250** generated / healed cases per run (template `maxScenarios` / `maxTests`).

## Healer boundary (ADR 0012)

`playwright-test-healer` may rewrite **platform-owned** generated test files only. It must **not**:

- commit, push, or edit a connected source repository
- introduce network / filesystem / secret imports into stubs

Source repositories remain read-only. See [`adr/0012-source-repositories-are-read-only-no-git-writes-no-automatic.md`](adr/0012-source-repositories-are-read-only-no-git-writes-no-automatic.md).

## How to run (operator)

1. Bind work-item connector (Azure Boards / Jira) and Squash as needed.
2. Bind Playwright browser (and/or source repo). Enable Explore UI and/or Explore code — at least one is required.
3. Optional: set `OLLAMA_URL` (and model) on the worker for model-backed plan / generate / heal.
4. On **Run**, enter the work item id (e.g. `7189`) and application name. When **Explore UI** is on, select an environment so the worker can resolve its application URL and open it with Playwright before planning. When **Explore code** is on, bind a source-repo connector so matching files are read before planning.
5. Confirm stage Done lines:
   - Explore names pages or records a skip note
   - Plan names `playwright-test-planner` and a `.plan.md` artifact with many scenarios
   - Generate names `playwright-test-generator` with case count matching the plan
   - Heal names `playwright-test-healer` (fixed N / none needed)
   - Publish stores cases under the work item (and Squash when writable)

## Code map

| Concern | Package |
|---------|---------|
| Ports, LLM prompts, MD plan, heuristics, healer | `packages/agents` |
| Step catalog + templates (order + caps) | `packages/workflow-definitions` |
| Sync offline `runFlowStep` | `packages/workflow-engine` |
| Composition root (gateway + browser invoker) | `apps/worker` (`requirement-agents.ts`, `main.ts`) |

## Related docs

- [`test-case-template.md`](test-case-template.md) — per-case fields (name, kind, priority, validation steps) through Squash
- [`playwright-agents-mcp.md`](playwright-agents-mcp.md) — enable model / browser / Cursor MCP
- [`requirement-validation-implementation.md`](requirement-validation-implementation.md) — phased build plan
- [`requirement-validation-phases.md`](requirement-validation-phases.md) — Phase 6 store / Phase 7 execute split
