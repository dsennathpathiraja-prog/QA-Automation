import { PlatformError } from '@qa/domain';

/** FIFO slot limiter: a local GPU serves only a few requests at once, so the rest queue here instead of timing out inside the provider. */
export class Semaphore {
  private free: number;
  private readonly waiters: { grant(): void; cancel(): void }[] = [];

  constructor(slots: number) {
    this.free = Math.max(1, slots);
  }

  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.free > 0) {
      this.free -= 1;
      return this.releaser();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remove(w);
        reject(new PlatformError('rate-limited', 'LLM provider is busy: no free slot before the queue timeout'));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.remove(w);
        reject(new PlatformError('cancelled', 'cancelled while waiting for an LLM slot'));
      };
      const w = {
        grant: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
        cancel: onAbort,
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  private remove(w: { grant(): void }) {
    const i = this.waiters.indexOf(w as never);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next.grant();
      else this.free += 1;
    };
  }
}
