import type { PlatformEnv, SecretStore } from '@qa/domain';
import { DbEnvelopeSecretStore, OpenBaoSecretStore, readSecretFile } from '@qa/infrastructure';
import { PgEnvelopeRows, type Db } from '@qa/persistence';
import type { Env } from './env';

export interface SecretStoreSelection {
  store: SecretStore;
  kind: 'openbao' | 'db-envelope';
}

/**
 * Picks the secret store from the environment.
 *   SECRET_STORE=openbao      BAO_ADDR + BAO_ROLE_ID_FILE + BAO_SECRET_ID_FILE (each container gets its own AppRole)
 *   SECRET_STORE=db-envelope  SECRET_MASTER_KEY_FILE (base64, 32 bytes). Development and CI only; refused in production.
 * With SECRET_STORE unset, OpenBao is used when BAO_ADDR is set; otherwise there is no store and connector credentials are disabled.
 */
export function buildSecretStore(env: Env, platformEnv: PlatformEnv, db: Db | undefined): SecretStoreSelection | undefined {
  const kind = env.SECRET_STORE ?? (env.BAO_ADDR ? 'openbao' : undefined);
  if (!kind) return undefined;
  if (kind === 'openbao') {
    const addr = env.BAO_ADDR;
    if (!addr) throw new Error('BAO_ADDR is required when SECRET_STORE=openbao');
    const roleId = env.BAO_ROLE_ID_FILE ? readSecretFile(env.BAO_ROLE_ID_FILE) : env.BAO_ROLE_ID;
    const secretId = env.BAO_SECRET_ID_FILE ? readSecretFile(env.BAO_SECRET_ID_FILE) : env.BAO_SECRET_ID;
    if (!roleId || !secretId) throw new Error('BAO_ROLE_ID_FILE and BAO_SECRET_ID_FILE are required when SECRET_STORE=openbao');
    return { kind: 'openbao', store: new OpenBaoSecretStore({ addr, mount: env.BAO_MOUNT, auth: { type: 'approle', roleId, secretId } }) };
  }
  if (kind === 'db-envelope') {
    if (platformEnv === 'production') throw new Error('SECRET_STORE=db-envelope is not allowed when PLATFORM_ENV=production');
    if (!db) throw new Error('SECRET_STORE=db-envelope needs a database');
    const raw = env.SECRET_MASTER_KEY_FILE ? readSecretFile(env.SECRET_MASTER_KEY_FILE) : env.SECRET_MASTER_KEY;
    if (!raw) throw new Error('SECRET_MASTER_KEY_FILE is required when SECRET_STORE=db-envelope');
    return { kind: 'db-envelope', store: new DbEnvelopeSecretStore(new PgEnvelopeRows(db), Buffer.from(raw, 'base64'), platformEnv) };
  }
  throw new Error(`Unknown SECRET_STORE: ${kind}`);
}
