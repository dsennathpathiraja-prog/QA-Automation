import { PlatformError } from '@qa/domain';
import type { EnvironmentRepository } from '@qa/application';

/**
 * Runs one queued environment check. The caller supplies the request, so this works
 * with the approved-host client today and can later hand the same address to a runner.
 */
export async function checkReachability(
  environments: Pick<EnvironmentRepository, 'claimReachability' | 'finishReachability'>,
  probe: (env: { id: string; applicationUrl: string }) => Promise<{ status: number; viaRunner?: boolean }>,
  now: Date = new Date(),
): Promise<'busy' | 'idle'> {
  const env = await environments.claimReachability();
  if (!env) return 'idle';
  try {
    const res = await probe(env);
    const answered = res.status >= 200 && res.status < 500;
    const who = res.viaRunner ? 'The runner finished. ' : '';
    await environments.finishReachability(
      env.id,
      answered ? 'reachable' : 'unreachable',
      answered ? `${who}The application answered ${res.status}.` : `${who}The application returned status ${res.status}.`,
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
