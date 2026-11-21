# Playwright planner, generator, healer, and browser agents

Requirement-validation case prep uses four roles. Catalog names vary; the platform keys are:

| Role | Platform agent / connector | Cursor MCP catalog names (typical) |
|------|----------------------------|------------------------------------|
| Explore UI before planning | `playwright-mcp` connector / `playwright-browser` | `playwright`, `playwright-browser`, `@playwright/mcp` |
| Plan many scenarios → durable MD artifact | `playwright-test-planner` (`@qa/agents`) | `playwright-test-planner` |
| Turn the MD plan into Playwright tests | `playwright-test-generator` (`@qa/agents`) | `playwright-test-generator` |
| Fix broken platform-owned stubs | `playwright-test-healer` (`@qa/agents`) | `playwright-test-healer` |

**Order:** explore UI/code → consolidate → planner (MD) → generator → healer → publish. See [`requirement-validation-case-workflow.md`](requirement-validation-case-workflow.md).

The worker prefers a **local model** (`OLLAMA_URL` or `VLLM_URL`) for planner, generator, and healer. When no model is configured, it uses a **description-aware heuristic** that builds **multiple** scenarios per acceptance criterion and Description path (not a single sparse triple). Optional UI exploration uses the bound Playwright browser connector when the run has an environment URL — and it runs **before** the plan so findings appear in the Markdown artifact.

Adapter interfaces for Cursor MCP packages live in `@qa/agents` (`plannerPortFromMcp`, `generatorPortFromMcp`, `healerPortFromMcp`, `explorerPortFromBrowserMcp`). The platform worker does not embed those MCP client packages; it uses the in-repo ports and the managed `playwright-mcp` connector.

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

1. Start the managed browser Compose profile (service name `playwright-mcp`, listens on **8931** inside the stack):

```bash
# Local trial (rebuilds qa-playwright-mcp:local — Chromium + pinned @playwright/mcp)
docker compose -f deploy/compose/local/docker-compose.local.yml --profile browser up --build -d playwright-mcp
# Host / production compose
docker compose --profile browser up --build -d playwright-mcp
```

The managed image launches with `--browser chromium` (the Playwright base image does not include Google Chrome at `/opt/google/chrome/chrome`). Rebuild the `browser` profile after changing `deploy/images/playwright-mcp.Dockerfile`.


2. In the UI, add a **Playwright (managed)** connector:
   - **Server address:** `http://playwright-mcp:8931` (from the worker container — not `localhost`; do not append `/mcp`).
   - **Application addresses:** comma-separated origins the browser may open.
   - Optional saved session name for MFA.
3. Approve host `playwright-mcp` for plain http when Test Connection / Approved hosts asks (Administrator).
4. Run **Test connection** — it should say the managed Playwright server is connected. If it says it could not reach Playwright, the browser profile is not up or the URL/host approval is wrong (see `deploy/compose/local/README.md`).
5. Bind that connector as **Browser automation** on the requirement-validation workflow. Enable the Explore UI step (UI / both templates).
6. On Run, supply an **environment** whose application URL matches an allowed origin (environments are optional for plan/generate; required for a real explore).

Without a browser or environment, explore records a skip note; plan and generate still complete using the story text.

## Local Cursor MCP config (developer machine)

For interactive planning/generation/healing inside Cursor (separate from the platform worker), add servers to `.cursor/mcp.json` or Cursor Settings → MCP. Example (no secrets):

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
    "playwright-test-healer": {
      "command": "npx",
      "args": ["-y", "@playwright/test-healer-mcp"],
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
2. Bind Playwright browser when Explore UI is on, plus a selectable environment whose URL is on the browser allowlist. Bind a source-repo connector when Explore code is on. Optional: set `OLLAMA_URL` for model-backed plans.
3. Publish the requirement-validation workflow if needed.
4. On **Run**, enter only `7189` in the story field and the application name (e.g. PayNSure). When Explore UI is on, select the environment (required in the Run form). Do not paste AC unless you want extra lines.
5. Start the run.
6. **Read** Done line should acknowledge the work item **title** and report N acceptance criteria from Description / AC (N > 0).
7. **Explore** (when enabled) runs **before** Plan: UI Done line acknowledges the visited website **URL**; code Done line **lists the files visited** (not the offline skip notes).
8. **Plan** Done line should name `playwright-test-planner`, a `.plan.md` artifact, and **many** Positive / Negative / Edge scenarios (more than 3×N when Description paths exist).
9. **Generate** consumes that MD plan; **Heal** fixes broken stubs; Test Cases (and Squash when READ_WRITE) list those cases under work item `7189`.

## Architecture (short)

```
Run story id
  → worker enrichStoryFromConnector (Azure Boards / Jira)
  → rv.read-user-story (criteria from Description)
  → rv.explore-ui (when on):
       environment → applicationUrl
       → browser.session.open → sessionId
       → browser.navigate({ sessionId, url }) → snapshot / screenshot
  → rv.explore-code (when on):
       bound source-repo config.repo
       → scm.code.search({ query, repo }) → scm.file.read
  → rv.consolidate-findings
  → rv.generate-test-plan → TestPlannerPort → planMarkdown + planArtifact
  → rv.generate-tests → TestGeneratorPort (MD plan + findings)
  → rv.heal-tests → TestHealerPort (platform workspace only)
  → rv.publish-testcases → Test Cases + Squash upsert
```

Enabled explore steps must succeed before plan. Fake Done stubs are only for offline unit tests (`runFlowStep`); the worker always wires `createBrowserExplorer` / `createCodeExplorer`. `packages/agents` owns the ports, MCP adapter contracts, MD plan helpers, and LLM prompts. `apps/worker` is the composition root that builds the gateway and connector invokers.
