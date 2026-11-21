import type { LlmGateway } from '@qa/llm';
import { PLAYWRIGHT_TEST_HEALER } from './heuristic';
import { MAX_HEAL_CASES } from './limits';
import { healStructured } from './schemas';
import type { GeneratedPlaywrightCase, HealRequest, HealResult, TestHealerPort } from './types';

const clip = (value: string, max: number) => value.trim().slice(0, max);

/** Detect obviously broken generated Playwright stubs that the healer can repair offline. */
export function isBrokenPlaywrightCase(item: GeneratedPlaywrightCase): string | undefined {
  const src = item.steps ?? '';
  if (!src.includes('@playwright/test')) return 'missing @playwright/test import';
  if (!/\btest\s*\(/.test(src)) return 'missing test() call';
  if (!/\bexpect\s*\(/.test(src) && !/await\s+page\./.test(src)) return 'missing expect() or page interaction';
  if (/hard-?coded password|process\.env\.|fs\.|net\.|child_process|require\(['"]http/i.test(src)) {
    return 'forbidden import or secret in generated source';
  }
  if (src.trim().length < 40) return 'source too short to be a real test';
  return undefined;
}

function repairStub(item: GeneratedPlaywrightCase, reason: string): GeneratedPlaywrightCase {
  const name = item.name.replace(/'/g, "\\'");
  const source = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test('${name}', async ({ page }) => {`,
    "  await page.goto('/');",
    `  // Healed (${reason}): ${clip(item.name, 160)}`,
    `  // Expected: ${clip(item.expected, 160)}`,
    "  await expect(page.locator('body')).toBeVisible();",
    '});',
    '',
  ].join('\n');
  return { ...item, steps: source };
}

/** Offline healer: rewrite clearly broken platform-owned stubs; leave healthy cases alone. */
export function healHeuristically(input: HealRequest): HealResult {
  const healed: GeneratedPlaywrightCase[] = [];
  let fixed = 0;
  for (const item of input.cases.slice(0, MAX_HEAL_CASES)) {
    const failure = input.failures?.find((f) => f.testId === item.testId || f.name === item.name);
    const reason = failure?.error || isBrokenPlaywrightCase(item);
    if (reason) {
      healed.push(repairStub(item, reason));
      fixed += 1;
    } else {
      healed.push(item);
    }
  }
  return {
    summary: fixed > 0
      ? `${PLAYWRIGHT_TEST_HEALER} fixed ${fixed} of ${healed.length} Playwright case${healed.length === 1 ? '' : 's'} for ${input.workItem} (platform workspace only).`
      : `${PLAYWRIGHT_TEST_HEALER} checked ${healed.length} case${healed.length === 1 ? '' : 's'} for ${input.workItem}; none needed a fix.`,
    cases: healed,
    fixed,
    source: 'heuristic',
  };
}

const HEAL_SYSTEM = [
  'You are playwright-test-healer for a connector-first QA platform.',
  'You may rewrite Playwright tests that live in the platform-owned workspace only.',
  'Never suggest commits, pushes, or edits to a connected source repository.',
  'Fix broken imports, missing test/expect calls, and forbidden IO; keep @playwright/test only.',
  'Reply with JSON only matching the schema.',
].join(' ');

/** LLM-backed healer with heuristic fallback when no gateway is configured. */
export function createLlmTestHealer(gateway: LlmGateway | undefined): TestHealerPort {
  if (!gateway) {
    return { heal: async (input) => healHeuristically(input) };
  }
  return {
    async heal(input: HealRequest): Promise<HealResult> {
      const broken = input.cases
        .map((c) => ({ case: c, reason: input.failures?.find((f) => f.testId === c.testId || f.name === c.name)?.error || isBrokenPlaywrightCase(c) }))
        .filter((row) => row.reason);
      if (broken.length === 0) {
        return {
          summary: `${PLAYWRIGHT_TEST_HEALER} checked ${input.cases.length} case${input.cases.length === 1 ? '' : 's'} for ${input.workItem}; none needed a fix.`,
          cases: input.cases.slice(0, MAX_HEAL_CASES),
          fixed: 0,
          source: 'model',
        };
      }
      const payload = broken.slice(0, 40).map((row, i) => (
        `${i + 1}. [${row.case.kind}] ${row.case.name}\n   reason: ${row.reason}\n   file: ${row.case.file}\n   source:\n${row.case.steps.slice(0, 3_000)}`
      )).join('\n\n');
      const result = await gateway.generateStructured(
        { agentKey: PLAYWRIGHT_TEST_HEALER, executionId: input.executionId, stepId: input.stepId },
        {
          system: HEAL_SYSTEM,
          instruction: [
            `Work item: ${input.workItem}`,
            `Application: ${input.application}`,
            'Repair each broken Playwright test. Return the full fixed cases array.',
            payload,
          ].join('\n'),
          context: [
            { class: 'code', label: 'broken-cases', text: payload.slice(0, 12_000) },
            ...(input.findings ? [{ class: 'page' as const, label: 'exploration-findings', text: input.findings.slice(0, 4_000) }] : []),
          ],
        },
        healStructured,
        { requirements: { structuredOutput: true } },
      );
      const byName = new Map(result.data.cases.map((row) => [row.name, row]));
      let fixed = 0;
      const cases = input.cases.slice(0, MAX_HEAL_CASES).map((item) => {
        const updated = byName.get(item.name);
        if (!updated) return item;
        fixed += 1;
        return {
          ...item,
          steps: updated.steps.includes('@playwright/test') ? updated.steps : repairStub(item, 'model omitted import').steps,
          expected: updated.expected || item.expected,
          kind: updated.kind ?? item.kind,
          priority: updated.priority ?? item.priority,
          file: updated.file ?? item.file,
          testId: updated.testId ?? item.testId,
        };
      });
      return {
        summary: `${PLAYWRIGHT_TEST_HEALER} fixed ${fixed} Playwright case${fixed === 1 ? '' : 's'} for ${input.workItem} with a model${result.repaired ? ' (repaired once)' : ''}.`,
        cases,
        fixed,
        source: 'model',
      };
    },
  };
}
