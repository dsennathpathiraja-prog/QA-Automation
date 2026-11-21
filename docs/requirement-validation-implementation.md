# Requirement validation: implementation plan

Written 19 Nov 2026. Updated the same day. The requirement-validation workflow ends when the cases are stored. Execution of a work item, with the environment chosen at that time, is a separate action. The phase split is [requirement-validation-phases.md](requirement-validation-phases.md).

## Already in a run
Durable order: **explore UI/code → consolidate → `playwright-test-planner` (Markdown plan artifact) → `playwright-test-generator` (many cases from that MD) → `playwright-test-healer` → publish**. Exploration runs before planning so findings feed the plan. The planner emits multiple Positive / Negative / Edge scenarios per acceptance criterion and Description path (caps 200 / 250) — not a hard stop at one triple. When `OLLAMA_URL` or `VLLM_URL` is set, planner / generator / healer call the local model through `LlmGateway`; otherwise description-aware heuristics run. Publish stores healed cases in Test Cases under the work item and in Squash when READ_WRITE. The run stops there. Engineers can clear platform cases via Test Cases → Clear platform test cases or `POST /api/v1/test-cases/reset` (Squash is not wiped).

Product workflow: [requirement-validation-case-workflow.md](requirement-validation-case-workflow.md). Cursor MCP wiring: [playwright-agents-mcp.md](playwright-agents-mcp.md). Executing the stored cases is a separate Executions action.

## 1. Read the work item
The Run tab takes the work item id. The worker calls the bound Azure Boards or Jira connector and reads the title, description, and acceptance criteria. Azure Boards turns Description HTML into text, reads the Acceptance Criteria field when set, and otherwise parses Acceptance Criteria / bullets / Given-When-Then from the Description (and Repro Steps when present). Those criteria become the planner input. When no work-item connector is selected, or the read is denied, the typed story stays the input, so a run without Azure or Jira still completes.

Done when a run of a real work item id shows the criteria from that work item in the Read stage, and the cases in Test Cases use that id.

## 2. Call the planner and the generator through a model
**Done in worker + `@qa/agents`.** When `OLLAMA_URL` or `VLLM_URL` is set, the worker sends the story to `playwright-test-planner` and the plan plus later findings to `playwright-test-generator`. Both answers must match a fixed shape: scenarios with a kind, and Playwright tests with a name, steps, expected result, and reference. A bad answer is repaired once. If it is still bad, the stage fails and says the model output was not usable.

When no model is configured, the description-aware heuristic runs and the Done line says the plan was written from the story without a model. The Models screen assignment comes after this, so the run is not blocked on that screen.

## 3. Walk the UI (before planning)
**Partial.** Explore UI runs **before** the planner. When enabled, an environment URL resolves, and a Playwright browser connector is bound, the worker opens the address, takes accessibility snapshots and screenshots for acceptance-criteria cues, and passes findings into consolidate → plan. It may open only the addresses listed on the browser connector. It does not submit a payment, delete data, or type a one-time code. Without those bindings the stage records a skip note and the run continues.

Done when the UI stage Done line acknowledges the visited website URL; screenshot bytes stay out of step outputs (execution stores screenshots later).

## 4. Read the source
The bound GitHub or Azure DevOps connector lists and reads the files that match the scenarios. The notes say which files were read and what they check. The connector stays read-only. Nothing is committed, pushed, or edited in that repository.

This slice can be built beside slice 3. Both have to finish before slice 5.

Done when the source stage Done line lists the files visited. A repository token that can push is still refused.

## 5. Use the findings when planning and generating
The consolidate stage joins the story, the UI notes, and the source notes. The **planner** receives those findings and embeds them in the Markdown plan. The **generator** consumes that MD plan (plus findings) so each Playwright test can mention the page or control exploration found. The reference stays stable for that work item and scenario, so Squash is not given a duplicate.

Done when changing a finding changes the plan / generated test text, and a second run updates the same Squash case.

## 6. Keep the Playwright file on the platform
The generator writes `tests/{application}/{work-item}.spec.js` into a platform workspace. The file may import `@playwright/test` and the platform helper only. A file that imports the network, the filesystem, or a hard-coded password is rejected and generated once more. The work item, the Squash case id, the file, and the Playwright test name are stored together. The file is never written to the connected repository.

Done when the test case in this platform shows the file path and the Squash id, and the workspace holds the `.spec.js`.

## 7. Run the file and keep a screenshot
The runner starts from the existing runner image, with the workspace as its only test input. It runs the generated file against the selected environment and writes one screenshot and one status for each test: Passed, Failed, Blocked, or Skipped. A failure of the application is Failed. A failure before the test can start is Blocked. The runner does not change the test or the application source.

Done when Executions, for that work item, shows each test with its status and its screenshot.

## 8. Send the result to Squash
For each executed case the worker finds the Squash case by its reference, records the execution, sets the status, and uploads the screenshot. The same run does not create a second execution for the same case. Executions shows the Squash id next to the screenshot.

Squash needs an iteration for an execution. The first build uses an iteration the connector can already see. If the token cannot create an execution, the Done line says so and the screenshot stays on Executions.

Done when the Squash case for that work item shows the status and the screenshot, and Executions shows the same pair.

## 9. Write the QA report
The report counts the acceptance criteria, the scenarios, and the results. It links the screenshots and says whether Squash accepted the status. It is stored with the run and opened from that run.

Done when the report on the run matches the statuses and the screenshots from slices 7 and 8.

## Held for later
Regression runs stay on their own workflow. They execute cases already in Squash and do not plan or generate. `playwright-test-healer` may rewrite platform-owned generated stubs only (not connected source repositories — ADR 0012). Kubernetes is unchanged. Source repositories stay read-only.
