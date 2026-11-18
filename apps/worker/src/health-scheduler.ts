import type { ConnectorRepository, TestRequestQueue } from '@qa/application';
import type { Clock } from '@qa/domain';
import { systemClock } from '@qa/domain';

export interface HealthSchedulerDeps {
  connectors: ConnectorRepository;
  tests: TestRequestQueue;
  clock?: Clock;
  /** How long after the last test before an enabled connector is tested again. 0 switches the schedule off. */
  intervalMs?: number;
}

/** Queues a Test Connection for every enabled connector that has not been tested within the interval. */
export class ConnectorHealthScheduler {
  private readonly clock: Clock;
  private readonly intervalMs: number;

  constructor(private readonly d: HealthSchedulerDeps) {
    this.clock = d.clock ?? systemClock;
    this.intervalMs = d.intervalMs ?? 15 * 60_000;
  }

  async enqueueDue(): Promise<number> {
    if (this.intervalMs <= 0) return 0;
    let queued = 0;
    for (const c of await this.d.connectors.list()) {
      if (!c.enabled || c.status === 'disconnected') continue;
      const testedAt = c.lastTestedAt?.getTime() ?? 0;
      if (c.lastTestedAt && this.clock.now().getTime() - testedAt < this.intervalMs) continue;
      const latest = await this.d.tests.latest(c.id);
      if (latest && (latest.status === 'pending' || latest.status === 'running')) continue;
      await this.d.tests.enqueue(c.id, c.configVersion, 'system:health');
      queued += 1;
    }
    return queued;
  }
}
