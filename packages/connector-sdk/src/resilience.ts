import { PlatformError, type Clock } from '@qa/domain';

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly capacity: number, private readonly refillPerSec: number, private readonly clock: Clock) {
    this.tokens = capacity;
    this.last = clock.now().getTime();
  }
  tryTake(): boolean {
    const now = this.clock.now().getTime();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly clock: Clock,
  ) {}

  assertClosed(): void {
    if (this.openedAt === undefined) return;
    if (this.clock.now().getTime() - this.openedAt >= this.cooldownMs) return; // half-open: allow a probe
    throw new PlatformError('transient', 'circuit breaker is open for this connector');
  }
  success(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }
  failure(err: unknown): void {
    if (err instanceof PlatformError && !['transient', 'rate-limited'].includes(err.errorClass)) return;
    this.failures += 1;
    if (this.failures >= this.threshold) this.openedAt = this.clock.now().getTime();
  }
}
