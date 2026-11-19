import { PlatformError } from '@qa/domain';
import type { EnvironmentRepository } from '@qa/application';

/**
 * Runs one queued environment check. The caller supplies the request, so this works
 * with the approved-host client today and can later hand the same address to a runner.
 */
export async function checkReachability(
  environments: Pick<EnvironmentRepository, 'claimReachability' | 'finishReachability'>,
  probe: (url: string) => Promise<{ status: number }>,
  now: Date = new Date(),
): Promise<'busy' | 'idle'> {
  const env = await environments.claimReachability();
  if (!env) return 'idle';
  try {
    const res = await probe(env.applicationUrl);
    const answered = res.status >= 200 && res.status < 500;
    await environments.finishReachability(
      env.id,
      answered ? 'reachable' : 'unreachable',
      answered ? `The application answered ${res.status}.` : `The application returned status ${res.status}.`,
      now,
    );
  } catch (e) {
    const detail = e instanceof PlatformError && e.errorClass === 'denied'
      ? 'The application host is not on the approved list, or the address was refused.'
      : e instanceof PlatformError
        ? e.message
        : 'The application did not answer.';
    await environments.finishReachability(env.id, 'unreachable', detail, now);
  }
  return 'busy';
}
