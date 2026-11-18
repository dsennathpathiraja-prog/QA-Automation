import { ProviderRegistry, createDefaultCapabilityRegistry, type CapabilityRegistry } from '@qa/connector-sdk';
import { azureBoardsProvider, azureDevOpsProvider, githubProvider, jiraProvider, playwrightMcpProvider, sampleProvider, squashProvider } from '@qa/infrastructure';
import type { PlatformEnv } from '@qa/domain';
import type { Env } from './env';

export interface Providers {
  capabilities: CapabilityRegistry;
  providers: ProviderRegistry;
}

/** The connector types this build can create. The demo provider is on outside production unless switched off. */
export function buildProviders(env: Env, platformEnv: PlatformEnv): Providers {
  const capabilities = createDefaultCapabilityRegistry();
  const providers = new ProviderRegistry(capabilities);
  providers.register(squashProvider);
  providers.register(githubProvider);
  providers.register(azureDevOpsProvider);
  providers.register(jiraProvider);
  providers.register(azureBoardsProvider);
  providers.register(playwrightMcpProvider);
  const sample = env.ENABLE_SAMPLE_PROVIDER ? env.ENABLE_SAMPLE_PROVIDER === 'true' : platformEnv !== 'production';
  if (sample) providers.register(sampleProvider);
  return { capabilities, providers };
}
