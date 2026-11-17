export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export type SecretMaterial = Record<string, string>;

export interface SecretLease {
  readonly value: SecretMaterial;
  readonly expiresAt: Date;
  /** Drops the in-memory copy. Callers must call this when done. */
  release(): void;
}

/**
 * Locators are opaque to callers. Values never leave this port except through lease().
 * Only the worker-side Connector Execution Manager and the runner launcher may call lease().
 */
export interface SecretStore {
  readonly kind: string;
  put(locator: string, material: SecretMaterial): Promise<{ version: number }>;
  lease(locator: string, opts?: { ttlMs?: number }): Promise<SecretLease>;
  exists(locator: string): Promise<boolean>;
  delete(locator: string): Promise<void>;
}

export interface ObjectMeta {
  key: string;
  size: number;
  sha256: string;
}

export interface ObjectStore {
  readonly kind: string;
  put(key: string, data: Uint8Array): Promise<ObjectMeta>;
  get(key: string): Promise<Uint8Array>;
  head(key: string): Promise<ObjectMeta | undefined>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<ObjectMeta[]>;
}

export type DeploymentProfile = 'standard' | 'restricted' | 'airgapped';
export type PlatformEnv = 'development' | 'test' | 'production';
