import { PlatformError } from '@qa/domain';
import type { CapabilityRegistry } from './catalog';
import type { ConnectorProvider } from './types';

export class ProviderRegistry {
  private readonly providers = new Map<string, ConnectorProvider>();

  constructor(private readonly capabilities: CapabilityRegistry) {}

  register(provider: ConnectorProvider): void {
    const m = provider.manifest;
    if (this.providers.has(m.providerKey)) throw new Error(`Provider already registered: ${m.providerKey}`);
    if (m.category === 'source-repo' && m.accessModePolicy !== 'read_only_enforced') {
      throw new Error(`Provider ${m.providerKey}: source-repo providers must use accessModePolicy 'read_only_enforced'`);
    }
    for (const id of m.capabilities) {
      const d = this.capabilities.get(id);
      if (d.category !== m.category) {
        throw new Error(`Provider ${m.providerKey} (${m.category}) declares capability ${id} of category ${d.category}`);
      }
      if (m.category === 'source-repo' && d.access !== 'read') {
        throw new Error(`Provider ${m.providerKey} declares write capability ${id} in source-repo category`);
      }
    }
    this.providers.set(m.providerKey, provider);
  }

  get(providerKey: string): ConnectorProvider {
    const p = this.providers.get(providerKey);
    if (!p) throw new PlatformError('unsupported', `Unknown connector provider: ${providerKey}`);
    return p;
  }

  all(): ConnectorProvider[] {
    return [...this.providers.values()];
  }
}
