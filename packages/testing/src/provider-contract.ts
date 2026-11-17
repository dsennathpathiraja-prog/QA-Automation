import { createDefaultCapabilityRegistry, ProviderRegistry, type ConnectorProvider } from '@qa/connector-sdk';

/**
 * Contract checks every provider package must pass in its own tests:
 * registration succeeds (category/capability/read-only invariants) and manifest is complete.
 */
export function assertProviderContract(provider: ConnectorProvider): string[] {
  const problems: string[] = [];
  try {
    new ProviderRegistry(createDefaultCapabilityRegistry()).register(provider);
  } catch (e) {
    problems.push((e as Error).message);
  }
  const m = provider.manifest;
  if (!m.displayName || !m.description) problems.push('manifest needs displayName and description');
  if (m.capabilities.length === 0) problems.push('manifest declares no capabilities');
  if (m.category === 'source-repo' && m.requiresInternet === undefined) problems.push('requiresInternet must be set');
  return problems;
}
