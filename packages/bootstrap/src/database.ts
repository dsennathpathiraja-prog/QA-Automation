import { readSecretFile } from '@qa/infrastructure';
import { connectPostgres, type PgConnection } from '@qa/persistence';
import type { Env } from './env';

export function connectDatabase(env: Env): PgConnection | undefined {
  if (!env.DATABASE_URL && !env.DATABASE_HOST) return undefined;
  const password = env.DATABASE_PASSWORD_FILE ? readSecretFile(env.DATABASE_PASSWORD_FILE) : env.DATABASE_PASSWORD;
  return connectPostgres({
    url: env.DATABASE_URL,
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT ? Number(env.DATABASE_PORT) : undefined,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password,
  });
}
