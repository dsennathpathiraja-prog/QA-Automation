import { buildApp } from './app';
import { DevHeaderSessionResolver } from './session';
import type { DeploymentProfile, PlatformEnv } from '@qa/domain';

const platformEnv = (process.env.PLATFORM_ENV ?? 'development') as PlatformEnv;
const profile = (process.env.PLATFORM_PROFILE ?? 'standard') as DeploymentProfile;

if (platformEnv === 'production') {
  // The OIDC session resolver (Keycloak) is the next Phase 1 increment; refuse to start without it.
  throw new Error('No production session resolver is configured yet (OIDC integration pending)');
}

const app = buildApp({ sessions: new DevHeaderSessionResolver(platformEnv), profile });
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
