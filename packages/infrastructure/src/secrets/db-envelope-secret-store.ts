import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PlatformError, type Clock, type PlatformEnv, type SecretLease, type SecretMaterial, type SecretStore, systemClock } from '@qa/domain';
import { assertLocator } from './locator';
import { makeLease } from './in-memory-secret-store';

export interface EnvelopeRow {
  locator: string;
  version: number;
  wrappedDek: string;
  dekIv: string;
  dekTag: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EnvelopeRowStore {
  get(locator: string): Promise<EnvelopeRow | undefined>;
  put(row: EnvelopeRow): Promise<void>;
  delete(locator: string): Promise<void>;
}

export class InMemoryEnvelopeRows implements EnvelopeRowStore {
  readonly rows = new Map<string, EnvelopeRow>();
  async get(l: string) {
    return this.rows.get(l);
  }
  async put(r: EnvelopeRow) {
    this.rows.set(r.locator, r);
  }
  async delete(l: string) {
    this.rows.delete(l);
  }
}

const seal = (key: Buffer, plain: Buffer, aad: string) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
};
const open = (key: Buffer, iv: string, tag: string, ct: string, aad: string) => {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
};

/**
 * Local development and CI only. Per-secret data key wrapped by a master key (AES-256-GCM).
 * Construction is refused in production so it can never silently replace OpenBao.
 */
export class DbEnvelopeSecretStore implements SecretStore {
  readonly kind = 'db-envelope';

  constructor(
    private readonly rows: EnvelopeRowStore,
    private readonly masterKey: Buffer,
    platformEnv: PlatformEnv,
    private readonly clock: Clock = systemClock,
  ) {
    if (platformEnv === 'production') throw new Error('DbEnvelopeSecretStore is not allowed when PLATFORM_ENV=production');
    if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
  }

  async put(locator: string, material: SecretMaterial) {
    assertLocator(locator);
    const prev = await this.rows.get(locator);
    const version = (prev?.version ?? 0) + 1;
    const dek = randomBytes(32);
    const data = seal(dek, Buffer.from(JSON.stringify(material)), `${locator}#${version}`);
    const wrapped = seal(this.masterKey, dek, `dek:${locator}#${version}`);
    await this.rows.put({
      locator,
      version,
      wrappedDek: wrapped.ct,
      dekIv: wrapped.iv,
      dekTag: wrapped.tag,
      iv: data.iv,
      tag: data.tag,
      ciphertext: data.ct,
    });
    return { version };
  }

  async lease(locator: string, opts?: { ttlMs?: number }): Promise<SecretLease> {
    assertLocator(locator);
    const row = await this.rows.get(locator);
    if (!row) throw new PlatformError('not-found', 'secret not found');
    try {
      const dek = open(this.masterKey, row.dekIv, row.dekTag, row.wrappedDek, `dek:${locator}#${row.version}`);
      const plain = open(dek, row.iv, row.tag, row.ciphertext, `${locator}#${row.version}`);
      return makeLease(JSON.parse(plain.toString()) as SecretMaterial, new Date(this.clock.now().getTime() + (opts?.ttlMs ?? 300_000)));
    } catch (e) {
      throw new PlatformError('internal', 'secret could not be decrypted', undefined, e);
    }
  }

  async exists(locator: string) {
    assertLocator(locator);
    return (await this.rows.get(locator)) !== undefined;
  }

  async delete(locator: string) {
    assertLocator(locator);
    await this.rows.delete(locator);
  }
}
