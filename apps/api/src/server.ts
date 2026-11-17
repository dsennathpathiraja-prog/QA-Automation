import type { DeploymentProfile, PlatformEnv } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, OidcProvider, OllamaAdapter, OpenAiCompatibleAdapter, readSecretFile, type EgressRule } from '@qa/infrastructure';
import type { LlmPort } from '@qa/llm';
import { PgAuditLog, PgSessionStore, PgUserRepository, connectPostgres, migrate, pingDb, seedDefaultGroupMappings, seedRoles, type Db } from '@qa/persistence';
import { buildApp } from './app';
import { OidcSessionResolver, type AuthConfig } from './auth';
import { DevHeaderSessionResolver } from './session';
import { InMemorySessionStore } from './session-store';

const env = process.env;
const platformEnv = (env.PLATFORM_ENV ?? 'development') as PlatformEnv;
const profile = (env.PLATFORM_PROFILE ?? 'standard') as DeploymentProfile;

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function connectDb() {
  const password = env.DATABASE_PASSWORD_FILE ? readSecretFile(env.DATABASE_PASSWORD_FILE) : env.DATABASE_PASSWORD;
  if (!env.DATABASE_URL && !env.DATABASE_HOST) return undefined;
  return connectPostgres({
    url: env.DATABASE_URL,
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT ? Number(env.DATABASE_PORT) : undefined,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password,
  });
}

function buildLlmStatus() {
  const configured: { id: string; port: LlmPort }[] = [];
  const rules: EgressRule[] = [];
  const addRule = (u: string) => {
    const url = new URL(u);
    rules.push({ hostPattern: url.hostname, purpose: 'llm', internal: true, allowHttp: url.protocol === 'http:', allowLoopback: true });
  };
  const ollamaUrl = env.OLLAMA_URL;
  const vllmUrl = env.VLLM_URL;
  if (ollamaUrl) addRule(ollamaUrl);
  if (vllmUrl) addRule(vllmUrl);
  if (rules.length === 0) return undefined;
  const http = new HardenedHttpClient({ egress: new EgressPolicy({ rules, profile, platformEnv }), allowedMethods: ['GET', 'POST'], timeoutMs: 300_000, maxBodyBytes: 16 * 1024 * 1024 });
  if (ollamaUrl) configured.push({ id: 'ollama', port: new OllamaAdapter({ baseUrl: ollamaUrl, http, keepAlive: env.OLLAMA_KEEP_ALIVE }) });
  if (vllmUrl) {
    const apiKey = env.VLLM_API_KEY_FILE ? readSecretFile(env.VLLM_API_KEY_FILE) : undefined;
    configured.push({ id: 'vllm', port: new OpenAiCompatibleAdapter({ baseUrl: vllmUrl, http, apiKey, adapterName: 'vllm' }) });
  }
  return {
    async providers() {
      return Promise.all(
        configured.map(async ({ id, port }) => {
          const signal = AbortSignal.timeout(4_000);
          const health = await port.health(signal);
          const models = health.ok ? await port.listModels(signal).catch(() => []) : [];
          return { id, kind: 'local' as const, adapter: port.adapter, enabled: true, health, models };
        }),
      );
    },
  };
}

function buildOidc(db: Db | undefined) {
  const issuer = required('OIDC_ISSUER');
  const internalBaseUrl = env.OIDC_INTERNAL_URL;
  const clientSecret = env.OIDC_CLIENT_SECRET_FILE ? readSecretFile(env.OIDC_CLIENT_SECRET_FILE) : required('OIDC_CLIENT_SECRET');
  const rules: EgressRule[] = [];
  for (const u of [internalBaseUrl, issuer].filter((x): x is string => !!x)) {
    const url = new URL(u);
    rules.push({ hostPattern: url.hostname, purpose: 'application', internal: true, allowHttp: url.protocol === 'http:' });
  }
  const http = new HardenedHttpClient({
    egress: new EgressPolicy({ rules, profile, platformEnv }),
    allowedMethods: ['GET', 'POST'],
    timeoutMs: 10_000,
    maxBodyBytes: 1_000_000,
  });
  const provider = new OidcProvider(
    { issuer, internalBaseUrl, clientId: required('OIDC_CLIENT_ID'), clientSecret, groupsClaim: env.OIDC_GROUPS_CLAIM },
    http,
  );
  const config: AuthConfig = {
    provider,
    store: db ? new PgSessionStore(db) : new InMemorySessionStore(),
    hooks: db ? dbHooks(db) : undefined,
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    secureCookies: required('PUBLIC_BASE_URL').startsWith('https://'),
    groupFormat: (env.OIDC_GROUP_FORMAT as 'name' | 'path' | 'object-id' | undefined) ?? 'name',
  };
  return { config, resolver: new OidcSessionResolver(config) };
}

function dbHooks(db: Db): NonNullable<AuthConfig['hooks']> {
  const users = new PgUserRepository(db);
  const audit = new PgAuditLog(db);
  const at = () => new Date().toISOString();
  return {
    isBlocked: (subject) => users.isDisabled(subject),
    onLogin: async (rec) => {
      await users.recordLogin({ subject: rec.userId, displayName: rec.displayName, email: rec.email, roles: rec.roles });
      await audit.append({ at: at(), actorId: rec.userId, action: 'auth.login', subjectType: 'user', subjectId: rec.userId, detail: { roles: rec.roles } });
    },
    onDenied: async ({ subject, reason }) => {
      await audit.append({ at: at(), actorId: subject, action: 'auth.login_denied', subjectType: 'user', subjectId: subject, detail: { reason } });
    },
    onLogout: async (rec) => {
      await audit.append({ at: at(), actorId: rec.userId, action: 'auth.logout', subjectType: 'user', subjectId: rec.userId });
    },
  };
}

const useOidc = platformEnv === 'production' || env.AUTH_MODE === 'oidc';
if (platformEnv === 'production' && env.AUTH_MODE === 'dev') throw new Error('AUTH_MODE=dev is not allowed when PLATFORM_ENV=production');

const conn = connectDb();
if (platformEnv === 'production' && !conn) throw new Error('A database is required in production (DATABASE_URL or DATABASE_HOST)');
if (conn && env.MIGRATE_ON_START !== 'false') {
  const r = await migrate(conn.db);
  await seedRoles(conn.db);
  await seedDefaultGroupMappings(conn.db);
  console.log(JSON.stringify({ msg: 'database ready', migrationsApplied: r.applied }));
}

const auth = useOidc ? buildOidc(conn?.db) : undefined;
const app = buildApp({
  sessions: auth ? auth.resolver : new DevHeaderSessionResolver(platformEnv),
  profile,
  auth,
  llm: buildLlmStatus(),
  readiness: conn ? { database: () => pingDb(conn.db) } : undefined,
});
const shutdown = async () => {
  await app.close();
  await conn?.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
await app.listen({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3000) });
