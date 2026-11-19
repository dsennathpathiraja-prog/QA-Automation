# Phases for the requirement-validation plan

Written 19 Nov 2026. This splits [requirement-validation-implementation.md](requirement-validation-implementation.md) into phases that follow Phase 6. A phase starts when the one before it is confirmed. The slice numbers below are the numbers in that plan.

Phases 1 to 5 stay as they are. Phase 6 stays the current phase until the generated cases are confirmed in Test Cases and in Squash.

The menu still shows older phase numbers on AI Agents, AI Models, Automation Mapping, Evidence, and Reports. Those labels change when the phase that builds the screen is started.

## Phase 6 — Executions and stored cases
Already started. Executions lists runs and their Done lines. Test Cases keeps the library. A requirement-validation run writes scenarios with `playwright-test-planner`, writes Playwright tests with `playwright-test-generator`, and stores the cases in Test Cases and in Squash.

This phase adds no new slice. It closes when a published run is confirmed: the Done lines are visible, and the cases for that work item are in Test Cases and in Squash.

## Phase 7 — Read the work item and call the agents
Slices 1 and 2.

The Run tab takes a work item id. The worker reads the description, acceptance criteria, and attachments from the bound Azure Boards or Jira connector. With no work-item connector, the typed story stays the input.

When a local model is configured, `playwright-test-planner` and `playwright-test-generator` answer in a fixed shape. A bad answer is repaired once, then the stage fails. With no model, the current rules stay and the Done line says the plan was written from the story. The AI Agents and AI Models screens leave their placeholders in this phase. The run is not blocked on those screens.

Done when a run of a real work item id shows that work item's criteria, and a run with a local model still stores the cases in Test Cases and in Squash.

## Phase 8 — Explore the UI and the source
Slices 3, 4, and 5. Slices 3 and 4 are built together. Slice 5 starts after both.

The Playwright browser opens the environment, follows the plan, and keeps a screenshot for each scenario. It opens only the addresses on the browser connector. GitHub or Azure DevOps is read for the matching files. The repository stays read-only. The generator then receives the story, the UI notes, and the source notes. The Squash reference for a scenario stays the same.

Done when the UI Done line names the pages, the source Done line names the files, each scenario has a screenshot from the walk, and a changed finding changes the generated test text.

## Phase 9 — Keep the Playwright file
Slice 6. This is the Automation Mapping screen.

The generator writes `tests/{application}/{work-item}.spec.js` into the platform workspace. The file may import `@playwright/test` and the platform helper only. The work item, the Squash case id, the file path, and the Playwright test name are stored together and shown on the test case. The file is never written to the connected repository.

Done when the test case shows that path and the Squash id, and the workspace holds the file.

## Phase 10 — Run the file and send the result
Slices 7 and 8. This is the Evidence screen, and Executions gains the screenshot for each test.

The runner runs the workspace file against the selected environment. Each test gets one status and one screenshot: Passed, Failed, Blocked, or Skipped. The worker records that execution in Squash, sets the status, and uploads the screenshot. The same run does not create a second execution for the same case. If Squash has no iteration the token can use, the Done line says so and the screenshot stays on Executions.

Done when Executions and the Squash case show the same status and the same screenshot for that work item.

## Phase 11 — QA report
Slice 9. This is the Reports screen for this workflow.

The report counts the acceptance criteria, the scenarios, and the results. It links the screenshots and says whether Squash accepted the status. It is stored with the run and opened from that run.

Done when the report matches the statuses and the screenshots from Phase 10.

## After this sequence
Regression stays its own workflow. It runs cases already in Squash and does not plan or generate. No healer rewrites a failing test. Source repositories stay read-only.

Kubernetes was called Phase 11 in the earlier notes. It is Phase 12, after this sequence.
