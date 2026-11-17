import { describe, expect, it } from 'vitest';
import type { RunnerLauncher } from '@qa/domain';
import { sampleRunnerSpec } from './fake-runner-launcher';

export interface LauncherUnderTest {
  launcher: RunnerLauncher;
  /** Makes the runner exit by itself with this code. */
  finish(runnerId: string, exitCode: number): Promise<void> | void;
  close?(): Promise<void> | void;
}

/** Behaviour every RunnerLauncher adapter must show, whatever it runs on. */
export function runnerLauncherContract(name: string, make: () => Promise<LauncherUnderTest>) {
  describe(`RunnerLauncher contract: ${name}`, () => {
    it('refuses an invalid spec before anything starts', async () => {
      const t = await make();
      await expect(t.launcher.launch(sampleRunnerSpec({ image: 'playwright:latest' }))).rejects.toMatchObject({ errorClass: 'validation' });
      expect(await t.launcher.list({})).toEqual([]);
      await t.close?.();
    });

    it('is idempotent on runId', async () => {
      const t = await make();
      const a = await t.launcher.launch(sampleRunnerSpec());
      const b = await t.launcher.launch(sampleRunnerSpec());
      expect(b.id).toBe(a.id);
      expect((await t.launcher.list({})).length).toBe(1);
      await t.close?.();
    });

    it('reports status, stop, natural exit codes and unknown runners', async () => {
      const t = await make();
      const a = await t.launcher.launch(sampleRunnerSpec({ runId: 'r-a' }));
      const b = await t.launcher.launch(sampleRunnerSpec({ runId: 'r-b' }));
      expect((await t.launcher.status(a.id)).state).toBe('running');
      await t.launcher.stop(a.id, 'user cancelled');
      expect((await t.launcher.status(a.id)).state).not.toBe('running');
      await t.finish(b.id, 1);
      expect(await t.launcher.status(b.id)).toMatchObject({ state: 'failed', exitCode: 1 });
      await expect(t.launcher.status('does-not-exist')).rejects.toMatchObject({ errorClass: 'not-found' });
      await t.close?.();
    });

    it('lists runners by label for the reaper', async () => {
      const t = await make();
      await t.launcher.launch(sampleRunnerSpec({ runId: 'r1', labels: { execution: 'ex-1' } }));
      await t.launcher.launch(sampleRunnerSpec({ runId: 'r2', labels: { execution: 'ex-2' } }));
      expect((await t.launcher.list({ execution: 'ex-2' })).map((r) => r.runId)).toEqual(['r2']);
      await t.close?.();
    });
  });
}
