# Phases for requirement validation

Written 19 Nov 2026. Updated the same day after the screens were compared with the agreed flow.

A requirement-validation workflow ends when the test cases are created and stored in Squash. The cases stay under the work item. Execution is a later action, one work item at a time, and the environment is chosen then. Regression comes after that: it runs the cases already stored in Squash and does not generate new ones.

The earlier draft of this page put execution, screenshots, and the report inside the same workflow, as Phases 7 to 11. That is not the product. Those steps are no longer part of the requirement-validation template, and an already published workflow stops after the cases are stored.

## Phase 6 — Store the cases, then execute by work item

This is the current phase.

A requirement-validation run reads the story, plans with `playwright-test-planner`, and writes the cases with `playwright-test-generator`. Publish stores them in Test Cases, in a collection named for the work item, and in Squash when that connector has a READ_WRITE token. The run stops there. It does not walk empty execute, sync, or report steps, including on a workflow that was published before this change. Starting the run does not ask for an environment.

Test Cases opens on the work items. It does not ask anyone to type a case by hand.

Executions asks for the work item and the environment. That row is marked prepared. The runner does not execute the Playwright file yet, so the page does not say the tests passed and it does not show a screenshot. Older workflow runs stay on the same page, labelled as the runs that created the cases.

This phase closes when a new run is confirmed: the cases for that work item are in Test Cases and in Squash. Run 1436518e, from 18 Nov 2026, is the old empty success. Rebuilding does not change that row.

## After Phase 6

Execute the stored cases for one work item on the environment chosen on Executions. Each case gets a real status and a screenshot, and that result is written to Squash. Until that exists, an execution stays prepared.

Regression is the next workflow. It reads the system's cases from Squash and runs them. It does not plan or generate.

Reading a work item from Azure Boards or Jira, calling a model for the two agents, walking the UI, and reading the source are how the generated cases get better. They happen before the cases are stored. Source repositories stay read-only. No healer rewrites a failing test.

Kubernetes stays later, after this sequence. It was called Phase 11 in the earlier notes and Phase 12 in the notes that followed.
