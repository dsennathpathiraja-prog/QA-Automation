# Playwright planner, generator, and browser agents

Requirement-validation case prep uses three roles. Catalog names vary; the platform keys are:

| Role | Platform agent / connector | Cursor MCP catalog names (typical) |
|------|----------------------------|------------------------------------|
| Plan Positive / Negative / Edge scenarios from the work item | `playwright-test-planner` (`@qa/agents`) | `playwright-test-planner` |
| Turn scenarios into Playwright tests | `playwright-test-generator` (`@qa/agents`) | `playwright-test-generator` |
| Optional UI explore + screenshots | `playwright-mcp` connector / `playwright-browser` | `playwright`, `playwright-browser`, `@playwright/mcp` |

The worker prefers a **local model** (`OLLAMA_URL` or `VLLM_URL`) for planner and generator. When no model is configured, it uses a **description-aware heuristic** that still builds three scenarios per acceptance criterion from the work item text (not a single sparse template). Optional UI exploration uses the bound Playwright browser connector when the run has an environment URL.

Adapter interfaces for Cursor MCP packages live in `@qa/agents` (`plannerPortFromMcp`, `generatorPortFromMcp`, `explorerPortFromBrowserMcp`). The platform worker does not embed those MCP client packages; it uses the in-repo ports and the managed `playwright-mcp` connector.

## Enable a local model (platform worker)

1. Run Ollama (or an OpenAI-compatible vLLM endpoint) on a host the worker may reach.
2. Set on the worker (Compose `llm` profile already sets Ollama on the stack):

```bash
OLLAMA_URL=http://ollama:11434   # or http://host.docker.internal:11434 from Compose local
OLLAMA_MODEL=qwen2.5:7b          # optional; default qwen2.5:7b
# or
VLLM_URL=http://vllm:8000/v1
VLLM_MODEL=your-model
# VLLM_API_KEY_FILE=/run/secrets/vllm_api_key   # never commit the key
```

3. Restart the worker. Startup logs `requirementAgents: "model"` when the gateway is wired, or `"heuristic"` when not.
4. Secrets stay in secret files / OpenBao — not in git.

## Enable Playwright browser exploration

1. Start the managed browser (`deploy/compose` profile that includes `playwright-mcp`, address typically `http://playwright-mcp:8931`).
2. In the UI, add a **Playwright (managed)** connector: server URL + comma-separated application origins the browser may open. Optional saved session name for MFA.
3. Bind that connector as **Browser automation** on the requirement-validation workflow. Enable the Explore UI step (UI / both templates).
4. On Run, supply an **environment** whose application URL matches an allowed origin (environments are optional for plan/generate; required for a real explore).

Without a browser or environment, plan and generate still complete; the UI stage records a short skip note.

## Local Cursor MCP config (developer machine)

For interactive planning/generation inside Cursor (separate from the platform worker), add servers to `.cursor/mcp.json` or Cursor Settings → MCP. Example (no secrets):

```json
{
  "mcpServers": {
    "playwright-test-planner": {
      "command": "npx",
      "args": ["-y", "@playwright/test-planner-mcp"],
      "env": {}
    },
    "playwright-test-generator": {
      "command": "npx",
      "args": ["-y", "@playwright/test-generator-mcp"],
      "env": {}
    },
    "playwright-browser": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "env": {}
    }
  }
}
```

Package names change across catalogs — point each server at the package you install, then map its tools onto the interfaces in `packages/agents/src/mcp-adapters.ts` if you wire a custom bridge. The in-repo worker path does not require these packages.

A checked-in template without secrets: [`deploy/cursor/mcp.json.example`](../deploy/cursor/mcp.json.example).

## Retest with a work item id (e.g. 7189 / PayNSure)

1. Ensure Azure Boards (or Jira) is bound as **Work items**, tested, and switched on.
2. Optional: bind Playwright browser + an environment whose URL is on the browser allowlist; set `OLLAMA_URL` for model-backed plans.
3. Publish the requirement-validation workflow if needed.
4. On **Run**, enter only `7189` in the story field and the application name (e.g. PayNSure). Do not paste AC unless you want extra lines.
5. Start the run.
6. **Read** should report N acceptance criteria from Description / AC (N > 0).
7. **Plan** Done line should name `playwright-test-planner` and either “with a model” or “from the story (no model)”, with **3 × N** Positive / Negative / Edge scenarios whose steps mention the criterion (payment criteria mention card/tax-style paths, not only “happy path”).
8. If Explore UI ran with a browser, its Done line names pages opened; **Generate** embeds exploration notes in the Playwright stubs.
9. Confirm Test Cases (and Squash when READ_WRITE) list those cases under work item `7189`.

## Architecture (short)

```
Run story id
  → worker enrichStoryFromConnector (Azure Boards / Jira)
  → rv.read-user-story (criteria from Description)
  → rv.generate-test-plan → TestPlannerPort (LLM gateway or heuristic)
  → rv.explore-ui (optional) → BrowserExplorerPort → playwright-mcp connector
  → rv.consolidate-findings
  → rv.generate-tests → TestGeneratorPort (LLM gateway or heuristic + findings)
  → rv.publish-testcases → Test Cases + Squash upsert
```

`packages/workflow-engine` keeps a sync heuristic `runFlowStep` for tests and offline fallback. `packages/agents` owns the ports, MCP adapter contracts, and LLM prompts. `apps/worker` is the composition root that builds the gateway and connector invokers.
