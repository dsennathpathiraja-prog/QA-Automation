import type { Assignment, AssignmentResolver, ProviderEntry, ProviderRegistry } from './types';

export class StaticProviderRegistry implements ProviderRegistry {
  private readonly m = new Map<string, ProviderEntry>();
  constructor(entries: readonly ProviderEntry[]) {
    for (const e of entries) {
      if (this.m.has(e.descriptor.id)) throw new Error(`duplicate LLM provider id ${e.descriptor.id}`);
      this.m.set(e.descriptor.id, e);
    }
  }
  get(id: string): ProviderEntry | undefined {
    return this.m.get(id);
  }
  list(): ProviderEntry[] {
    return [...this.m.values()];
  }
}

/** Configuration-driven resolver. The database-backed resolver (AI Models screen, qualification gate) arrives in Phase 5. */
export class StaticAssignmentResolver implements AssignmentResolver {
  constructor(private readonly byAgent: Record<string, Assignment>, private readonly defaultAssignment?: Assignment) {}
  async resolve(agentKey: string): Promise<Assignment | undefined> {
    return this.byAgent[agentKey] ?? this.defaultAssignment;
  }
}
