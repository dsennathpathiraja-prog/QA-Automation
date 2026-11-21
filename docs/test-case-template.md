# Per-case template (generator → platform → Squash)

**Did a template already exist?** Not as a standalone documented contract. Before this doc, the shape lived only in Zod (`GeneratedCaseSchema` in `packages/agents`) and TypeScript (`GeneratedPlaywrightCase`). Operators had no single place that answered “what fields every case must have.” This page is that contract.

Code source of truth: [`packages/agents/src/case-template.ts`](../packages/agents/src/case-template.ts).

## Required fields

| Field | Purpose | Squash mapping |
|-------|---------|----------------|
| `name` | Prefer `Positive: <work item title> — <goal>` (same for Negative / Edge) | Test case **name** (≤255) |
| `kind` | `positive` \| `negative` \| `edge` | In **description** HTML |
| `priority` | `high` \| `medium` \| `low` (defaults: negative→high, edge→low, else medium) | In **description** HTML |
| `steps` | Playwright `.spec.js` source for the platform library / runner | Not pasted into Squash actions |
| `expected` | Overall expected outcome | Description + last validation step when needed |
| `validationSteps` | Human steps `{ action, expected }[]` | **Action steps** (`action` + `expected_result`) |
| `workItem` | Azure / Jira / pasted id | Description |
| `reference` | Idempotency key `QAP-{work}-{n}` (≤50) | **`automated_test_reference`** |
| `file` / `testId` | Workspace path and stable id | Description (file) |

## Example

```json
{
  "name": "Positive: PayNSure checkout — Saved card is listed",
  "kind": "positive",
  "priority": "medium",
  "steps": "import { test, expect } from '@playwright/test';\n\ntest('Positive: PayNSure checkout — Saved card is listed', async ({ page }) => {\n  await page.goto('/');\n  // Steps: Open checkout. Confirm saved card row.\n  await expect(page.locator('body')).toBeVisible();\n});\n",
  "expected": "The saved card is listed on checkout",
  "validationSteps": [
    { "action": "Open checkout", "expected": "" },
    { "action": "Confirm saved card row", "expected": "The saved card is listed on checkout" }
  ],
  "workItem": "7259",
  "reference": "QAP-7259-1",
  "file": "tests/paynsure/7259.spec.js",
  "testId": "7259-positive-1"
}
```

## Publish → Squash

`rv.publish-testcases` calls `tm.testcase.upsert` with:

1. **name** — `meaningfulCaseName` (adds kind prefix when missing)
2. **automated_test_reference** — `reference`
3. **description** — HTML with kind, priority, work item, reference, expected, automation file
4. **steps** — `validationSteps` (or derived from a `// Steps:` comment / name+expected fallback)

Create: `POST /test-cases` then `POST /test-cases/{id}/steps`.  
Update (same reference): `PATCH /test-cases/{id}`, `DELETE /test-steps/{stepId}` for old steps, then POST new steps.

## Execution → Squash

After a work-item run, `syncCaseResultsToSquash` for each case:

1. Resolve Squash case id from the platform summary (`Squash {id}`)
2. `tm.execution.upsert` → `POST /iterations/{id}/executions`
3. `tm.execution.status.update` → `PATCH /executions/{id}` with `SUCCESS` / `FAILURE` / `BLOCKED` / `UNTESTABLE`

## Related

- [`requirement-validation-case-workflow.md`](./requirement-validation-case-workflow.md) — explore → plan → generate → heal → publish
- [`phase6-status.md`](./phase6-status.md) — Squash store status
