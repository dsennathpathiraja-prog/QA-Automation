# Requirement validation: implementation plan

Written 19 Nov 2026. Updated the same day. The requirement-validation workflow ends when the cases are stored. Execution of a work item, with the environment chosen at that time, is a separate action. The phase split is [requirement-validation-phases.md](requirement-validation-phases.md).

## Already in a run
The story is the text typed on the Run tab. `playwright-test-planner` writes a positive, a negative, and an edge scenario for each acceptance criterion. `playwright-test-generator` writes one Playwright test for each scenario. Publish stores those cases in Test Cases under the work item, in a collection of that name, and in Squash when the connector has a READ_WRITE token. The same reference is not created twice. The run stops there.

The UI stage and the source stage do not drive a browser or read a repository yet. The planner and the generator do not call a model yet. Executing the stored cases, with a screenshot and a Squash result, is the execution of the work item. It is not another step of this workflow.

## 1. Read the work item
The Run tab takes the work item id. The worker calls the bound Azure Boards or Jira connector and reads the description, the acceptance criteria, and the attachments. Those criteria become the planner input. When no work-item connector is selected, the typed story stays the input, so a run without Azure or Jira still completes.

Done when a run of a real work item id shows the criteria from that work item in the Read stage, and the cases in Test Cases use that id.

## 2. Call the planner and the generator through a model
When `OLLAMA_URL` or `VLLM_URL` is set, the worker sends the story to `playwright-test-planner` and the plan plus later findings to `playwright-test-generator`. Both answers must match a fixed shape: scenarios with a kind, and Playwright tests with a name, steps, expected result, and reference. A bad answer is repaired once. If it is still bad, the stage fails and says the model output was not usable.

When no model is configured, the current rules stay and the Done line says the plan was written from the story without a model. The Models screen assignment comes after this, so the run is not blocked on that screen.

Done when a run with a local model shows the planner and generator Done lines, and the cases still appear in Test Cases and in Squash.

## 3. Walk the UI
The bound Playwright browser opens the environment address and follows the scenarios from the plan. It records what it saw, and it takes a screenshot at the end of each scenario. It may open only the addresses listed on the browser connector. It does not submit a payment, delete data, or type a one-time code. A saved browser session is used when the connector has one.

Done when the UI stage Done line names the pages it opened, and each scenario has a stored screenshot.

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
