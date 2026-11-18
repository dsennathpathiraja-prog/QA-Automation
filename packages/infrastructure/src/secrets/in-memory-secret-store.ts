import { PlatformError, type Clock, type SecretLease, type SecretMaterial, type SecretStore, systemClock } from '@qa/domain';
import { assertLocator } from './locator';

export class InMemorySecretStore implements SecretStore {
  readonly kind = 'in-memory';
  private readonly data = new Map<string, { version: number; material: SecretMaterial }>();
  readonly leaseCount = { value: 0 };

  constructor(private readonly clock: Clock = systemClock) {}

  get size(): number {
    return this.data.size;
  }

  async put(locator: string, material: SecretMaterial) {
    assertLocator(locator);
    const version = (this.data.get(locator)?.version ?? 0) + 1;
    this.data.set(locator, { version, material: { ...material } });
    return { version };
  }

  async lease(locator: string, opts?: { ttlMs?: number }): Promise<SecretLease> {
    assertLocator(locator);
    const e = this.data.get(locator);
    if (!e) throw new PlatformError('not-found', 'secret not found');
    this.leaseCount.value += 1;
    return makeLease({ ...e.material }, new Date(this.clock.now().getTime() + (opts?.ttlMs ?? 300_000)));
  }

  async exists(locator: string) {
    assertLocator(locator);
    return this.data.has(locator);
  }

  async delete(locator: string) {
    assertLocator(locator);
    this.data.delete(locator);
  }
}

export function makeLease(value: SecretMaterial, expiresAt: Date): SecretLease {
  let released = false;
  const holder = value;
  return {
    get value() {
      if (released) throw new PlatformError('internal', 'secret lease already released');
      return holder;
    },
    expiresAt,
    release() {
      released = true;
      for (const k of Object.keys(holder)) holder[k] = '';
    },
  };
}
