import { PlatformError } from '@qa/domain';
import type { CodeExploreRequest, CodeExploreResult, CodeExplorerPort, CodeFinding, SourceRepoPort } from './types';

const slugWords = (value: string): string[] => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(/\s+/)
  .map((w) => w.trim())
  .filter((w) => w.length >= 3 && w.length <= 40);

/**
 * Read-only source explorer. Searches the bound GitHub / Azure DevOps repo and
 * reads matching files BEFORE the planner so findings feed the Markdown plan.
 * Failures throw — Explore code must succeed with a real connector call.
 */
export function createCodeExplorer(repo: SourceRepoPort | undefined): CodeExplorerPort {
  return {
    async explore(input: CodeExploreRequest): Promise<CodeExploreResult> {
      if (!repo) {
        throw new PlatformError(
          'denied',
          'Explore code needs a bound source-repo connector (GitHub or Azure DevOps) before planning.',
        );
      }

      const seeds = [
        ...slugWords(input.application),
        ...(input.criteria ?? []).flatMap(slugWords),
        ...slugWords(input.workItem ?? ''),
      ];
      const queries = [...new Set(seeds)].slice(0, input.maxQueries ?? 6);
      if (queries.length === 0) queries.push(input.application || 'test');

      const details: CodeFinding[] = [];
      const seen = new Set<string>();
      const maxFiles = Math.min(input.maxFiles ?? 12, 40);

      for (const query of queries) {
        if (details.length >= maxFiles) break;
        const hits = await repo.search({ query, repo: input.repo });
        for (const hit of hits) {
          if (details.length >= maxFiles) break;
          const path = hit.path.trim();
          if (!path || seen.has(path)) continue;
          seen.add(path);
          let contentExcerpt = (hit.snippet ?? '').slice(0, 1_200);
          try {
            const file = await repo.readFile({ path, repo: input.repo });
            if (file.content) contentExcerpt = file.content.slice(0, 1_200);
          } catch {
            /* search hit is still useful when a single file read fails */
          }
          details.push({ path, query, snippet: hit.snippet ?? '', contentExcerpt });
        }
      }

      const repoLabel = input.repo?.trim() || 'bound repository';
      const findings = details.length > 0
        ? details.map((d) => `- ${d.path} (query: ${d.query})\n  ${(d.contentExcerpt || d.snippet).slice(0, 280).replace(/\s+/g, ' ')}`).join('\n')
        : `searched ${repoLabel} for: ${queries.join(', ')} (no file hits)`;

      return {
        summary: details.length > 0
          ? `source-repo read ${details.length} file${details.length === 1 ? '' : 's'} in ${repoLabel} for ${input.application} (before planning).`
          : `source-repo searched ${repoLabel} for ${input.application} before planning (${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, no file hits).`,
        findings,
        details,
        source: 'repo',
        repo: input.repo,
      };
    },
  };
}

/** Adapt ConnectorExecutionManager-style invokes into SourceRepoPort. */
export function sourceRepoPortFromInvoker(
  invoke: (capability: string, input?: Record<string, unknown>) => Promise<unknown>,
): SourceRepoPort {
  return {
    async search(input) {
      const body: Record<string, unknown> = { query: input.query };
      if (input.repo) body.repo = input.repo;
      if (input.branch) body.branch = input.branch;
      const out = await invoke('scm.code.search', body) as { items?: { path?: string; snippet?: string }[] };
      return (out?.items ?? []).flatMap((item) => {
        const path = typeof item?.path === 'string' ? item.path : '';
        if (!path) return [];
        return [{ path, snippet: typeof item.snippet === 'string' ? item.snippet : '' }];
      });
    },
    async readFile(input) {
      const body: Record<string, unknown> = { path: input.path };
      if (input.repo) body.repo = input.repo;
      if (input.branch) body.branch = input.branch;
      const out = await invoke('scm.file.read', body) as { path?: string; content?: string; truncated?: boolean };
      return {
        path: out?.path ?? input.path,
        content: out?.content ?? '',
        truncated: Boolean(out?.truncated),
      };
    },
  };
}
