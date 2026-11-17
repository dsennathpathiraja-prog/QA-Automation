import type { DeploymentProfile, PlatformEnv } from '@qa/domain';
import { EgressPolicy, HardenedHttpClient, OidcProvider, readSecretFile, type EgressRule } from '@qa/infrastructure';
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

function buildOidc() {
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
    store: new InMemorySessionStore(),
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    secureCookies: required('PUBLIC_BASE_URL').startsWith('https://'),
    groupFormat: (env.OIDC_GROUP_FORMAT as 'name' | 'path' | 'object-id' | undefined) ?? 'name',
  };
  return { config, resolver: new OidcSessionResolver(config) };
}

const useOidc = platformEnv === 'production' || env.AUTH_MODE === 'oidc';
if (platformEnv === 'production' && env.AUTH_MODE === 'dev') throw new Error('AUTH_MODE=dev is not allowed when PLATFORM_ENV=production');

const auth = useOidc ? buildOidc() : undefined;
const app = buildApp({
  sessions: auth ? auth.resolver : new DevHeaderSessionResolver(platformEnv),
  profile,
  auth,
});
await app.listen({ host: env.HOST ?? '127.0.0.1', port: Number(env.PORT ?? 3000) });
