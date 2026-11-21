# Requirement validation: implementation plan

Written 19 Nov 2026. Updated the same day. The requirement-validation workflow ends when the cases are stored. Execution of a work item, with the environment chosen at that time, is a separate action. The phase split is [requirement-validation-phases.md](requirement-validation-phases.md).

## Already in a run
The story is the text typed on the Run tab (or the work item loaded by id). `playwright-test-planner` writes a positive, a negative, and an edge scenario for each acceptance criterion (with priority high/medium/low by kind). `playwright-test-generator` writes one Playwright test for each scenario. When `OLLAMA_URL` or `VLLM_URL` is set on the worker, both agents call the local model through `LlmGateway` with a fixed JSON shape (one repair). Otherwise a description-aware heuristic still builds criterion-specific steps. Optional Explore UI uses the bound `playwright-mcp` connector when an environment URL is present. Publish stores those cases in Test Cases under the work item, in a collection of that name, and in Squash when the connector has a READ_WRITE token. The same reference is not created twice. The run stops there. Engineers can clear platform cases via Test Cases → Clear platform test cases or `POST /api/v1/test-cases/reset` (Squash is not wiped).

Cursor MCP wiring and retest steps: [playwright-agents-mcp.md](playwright-agents-mcp.md). Executing the stored cases, with a screenshot and a Squash result, is the execution of the work item. It is not another step of this workflow.

## 1. Read the work item
The Run tab takes the work item id. The worker calls the bound Azure Boards or Jira connector and reads the title, description, and acceptance criteria. Azure Boards turns Description HTML into text, reads the Acceptance Criteria field when set, and otherwise parses Acceptance Criteria / bullets / Given-When-Then from the Description (and Repro Steps when present). Those criteria become the planner input. When no work-item connector is selected, or the read is denied, the typed story stays the input, so a run without Azure or Jira still completes.

Done when a run of a real work item id shows the criteria from that work item in the Read stage, and the cases in Test Cases use that id.

## 2. Call the planner and the generator through a model
**Done in worker + `@qa/agents`.** When `OLLAMA_URL` or `VLLM_URL` is set, the worker sends the story to `playwright-test-planner` and the plan plus later findings to `playwright-test-generator`. Both answers must match a fixed shape: scenarios with a kind, and Playwright tests with a name, steps, expected result, and reference. A bad answer is repaired once. If it is still bad, the stage fails and says the model output was not usable.

When no model is configured, the description-aware heuristic runs and the Done line says the plan was written from the story without a model. The Models screen assignment comes after this, so the run is not blocked on that screen.

## 3. Walk the UI
**Partial.** When Explore UI is enabled, an environment URL resolves, and a Playwright browser connector is bound, the worker opens the address, takes accessibility snapshots and screenshots for up to a few planned scenarios, and passes findings into generate. It may open only the addresses listed on the browser connector. It does not submit a payment, delete data, or type a one-time code. A saved browser session is used when the connector has one. Without those bindings the stage records a skip note and the run continues.

Done when the UI stage Done line names the pages it opened; screenshot bytes stay out of step outputs (execution stores screenshots later).

## 4. Read the source
The bound GitHub or Azure DevOps connector lists and reads the files that match the scenarios. The notes say which files were read and what they check. The connector stays read-only. Nothing is committed, pushed, or edited in that repository.

This slice can be built beside slice 3. Both have to finish before slice 5.

Done when the source stage Done line names the files it read. A repository token that can push is still refused.

## 5. Use the findings when generating
The consolidate stage joins the story, the UI notes, and the source notes. The generator receives that joined note with the plan. The Playwright test for a scenario mentions the page and the check the exploration found. The reference stays stable for that work item and scenario, so Squash is not given a duplicate.

Done when changing a finding changes the generated test text, and a second run updates the same Squash case.

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
Regression runs stay on their own workflow. They execute cases already in Squash and do not plan or generate. No healer rewrites a failing test. Kubernetes is unchanged. Source repositories stay read-only.
