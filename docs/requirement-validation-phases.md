# Phases for requirement validation

Written 19 Nov 2026. Updated the same day after the screens were compared with the agreed flow.

A requirement-validation workflow ends when the test cases are created and stored in Squash. The cases stay under the work item. Execution is a later action, one work item at a time, and the environment is chosen then. Regression comes after that: it runs the cases already stored in Squash and does not generate new ones.

The earlier draft of this page put execution, screenshots, and the report inside the same workflow, as Phases 7 to 11. That is not the product. Those steps are no longer part of the requirement-validation template, and an already published workflow stops after the cases are stored.

## Phase 6 — Store the cases, then prepare by work item

A requirement-validation run reads the story, plans with `playwright-test-planner`, and writes the cases with `playwright-test-generator`. Publish stores them in Test Cases, in a collection named for the work item, and in Squash when that connector has a READ_WRITE token. The run stops there. Starting the run does not ask for an environment.

Executions asks for the work item and the environment. That row is marked prepared until Phase 7 runs it.

## Phase 7 — Execute prepared work items (current)

From Executions, run a prepared work item against the chosen environment. The worker uses the existing runner-launcher profile when it is up (`bundleRef: work-item`). Each case gets Passed, Failed, Blocked, or Skipped, plus a screenshot. When Squash is writable (project name such as ToolKit-AgenFlow), the execution status is written back. Plan: [`phase7-plan.md`](phase7-plan.md).

Regression is the next workflow. It reads the system's cases from Squash and runs them. It does not plan or generate.

Reading a work item from Azure Boards or Jira, calling a model for the two agents, walking the UI, and reading the source are how the generated cases get better. They happen before the cases are stored. Source repositories stay read-only. No healer rewrites a failing test.

Kubernetes stays later, after this sequence. It was called Phase 11 in the earlier notes and Phase 12 in the notes that followed.
