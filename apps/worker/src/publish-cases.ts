import { PlatformError } from '@qa/domain';
import type { TestCaseService } from '@qa/application';

export interface GeneratedCase {
  name: string;
  steps: string;
  expected: string;
  workItem: string;
  reference: string;
}

interface SquashResult {
  id: string;
  created: boolean;
  projectId?: string;
}

/**
 * Saves each generated case in Test Cases and, when a Squash connector is bound, stores it there.
 * A repeated reference is kept as the same Squash case.
 */
export async function publishGeneratedCases(input: {
  workItem: string;
  cases: GeneratedCase[];
  testCases: TestCaseService;
  squash?: (item: GeneratedCase) => Promise<SquashResult>;
}): Promise<{ summary: string }> {
  const workItem = input.workItem || 'work-item';
  if (input.cases.length === 0) return { summary: `No test cases were generated for ${workItem}. Nothing was sent to Squash.` };
  const squashIds: string[] = [];
  const references: string[] = [];
  let projectId = '';
  let squashError = '';
  for (const item of input.cases) {
    let squashId = '';
    if (input.squash && !squashError) {
      try {
        const saved = await input.squash(item);
        squashId = saved.id;
        squashIds.push(saved.id);
        references.push(item.reference);
        if (!projectId && saved.projectId) projectId = saved.projectId;
      } catch (e) {
        squashError = e instanceof PlatformError ? e.message : 'Squash did not accept the test case.';
        if (/not bound/i.test(squashError)) {
          squashError = 'No Squash connector is bound on this workflow run. On the workflow Connectors tab choose Squash, then republish and run again.';
        } else if (/read-only/i.test(squashError) && !/token is READ-only/i.test(squashError) && !/READ_WRITE/i.test(squashError)) {
          squashError = 'The Squash connector is still read-only. Rebuild so migration 0010 applies, or recreate the connector, then Switch on and run again.';
        }
      }
    }
    await input.testCases.fileUnderWorkItem(
      { id: 'worker' },
      {
        name: item.name,
        steps: item.steps,
        expected: item.expected,
        workItem: item.workItem || workItem,
        reference: item.reference,
        summary: squashId ? `Squash ${squashId}` : item.reference,
      },
    );
  }
  const count = input.cases.length;
  const noun = `test case${count === 1 ? '' : 's'}`;
  const kept = `Stored ${count} ${noun} for ${workItem} under that work item`;
  if (!input.squash) return { summary: `${kept} in Test Cases. No Squash connector is selected on this workflow.` };
  if (squashError && squashIds.length === 0) return { summary: `${kept} in Test Cases. Squash did not store them: ${squashError}` };
  if (squashError) return { summary: `${kept} in Test Cases. Squash stored ${squashIds.length} and then stopped: ${squashError}` };
  const where = projectId ? `Squash project ${projectId}` : 'Squash';
  const refs = references.length > 0 ? ` References: ${references.join(', ')}. Squash ids: ${squashIds.join(', ')}.` : '';
  return { summary: `${kept} in Test Cases and in ${where}.${refs}` };
}
