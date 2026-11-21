import { PlatformError } from '@qa/domain';
import type { CodeExploreRequest, CodeExploreResult, CodeExplorerPort, CodeFinding, SourceRepoPort } from './types';

const SEARCH_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'as', 'by',
  'from', 'that', 'this', 'it', 'user', 'should', 'must', 'can', 'will', 'when', 'then', 'given',
]);

/** Pull short search tokens from acceptance criteria / application name. */
export function searchQueriesFor(application: string, criteria: string[]): string[] {
  const words = [application, ...criteria]
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\s]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !SEARCH_STOP.has(w));
  const unique = [...new Set(words)];
  const queries = unique.slice(0, 6);
  if (queries.length === 0 && application.trim()) queries.push(application.trim());
  return queries;
}

/**
 * Repo-relative paths operators can open. Rejects bare git object ids (SHAs) that
 * some connectors historically returned as fake "paths" from commit search.
 */
export function isHumanFilePath(path: string): boolean {
  const p = path.trim().replace(/^\.\//, '');
  if (!p) return false;
  if (/^[0-9a-f]{7,40}$/i.test(p)) return false;
  return true;
}

/**
 * Prefer application source over accidental HTML / SDK / docs hits (common when a
 * GitHub docs repo or Azure HTML/SDK tree is bound instead of the real Azure Repos app).
 */
export function isExplorableSourcePath(path: string): boolean {
  if (!isHumanFilePath(path)) return false;
  const p = displayFilePath(path);
  if (/\.(html?|htm)$/i.test(p)) return false;
  if (/(^|\/)(node_modules|dist|build|out|coverage|\.git)\//i.test(p)) return false;
  if (/(^|\/)(sdk|html-sdk|api-docs|typedoc|jsdoc)(\/|$)/i.test(p)) return false;
  if (/(^|\/)(docs\/api|documentation\/api|wwwroot\/lib)\//i.test(p)) return false;
  return true;
}

/** Strip a leading slash so Azure DevOps `/src/a.ts` reads as `src/a.ts`. */
export function displayFilePath(path: string): string {
  return path.trim().replace(/^\/+/, '') || path.trim();
}

/**
 * Read-only source explorer. Prefer a bound Azure DevOps Repos connector (real app
 * source) over GitHub/HTML SDK trees. Searches and reads matching files BEFORE the
 * planner so findings feed the Markdown plan. Failures throw — Explore code must
 * succeed with a real connector call.
 * `repo` may be omitted when the connector binds one (manager injects config.repo).
 */
export function createCodeExplorer(source: SourceRepoPort | undefined): CodeExplorerPort {
  return {
    async explore(input: CodeExploreRequest): Promise<CodeExploreResult> {
      if (!source) {
        throw new PlatformError(
          'denied',
          'Explore code needs a bound Azure DevOps Repos (or GitHub) source-repo connector before planning.',
        );
      }

      const queries = searchQueriesFor(input.application, input.criteria ?? []).slice(0, input.maxQueries ?? 6);
      if (queries.length === 0) queries.push(input.application || 'test');
      const maxFiles = Math.min(Math.max(1, input.maxFiles ?? 12), 40);
      const byPath = new Map<string, CodeFinding>();
      const repoOpts = input.repo ? { repo: input.repo } : {};

      for (const query of queries) {
        if (byPath.size >= maxFiles) break;
        const found = await source.search({ query, ...repoOpts });
        for (const hit of found.items) {
          if (!hit.path || !isExplorableSourcePath(hit.path)) continue;
          const path = displayFilePath(hit.path);
          if (!path || byPath.has(path)) continue;
          byPath.set(path, {
            path,
            excerpt: (hit.snippet || '').slice(0, 800),
            query,
          });
          if (byPath.size >= maxFiles) break;
        }
      }

      // When search returns nothing (or only HTML/SDK/SHA noise), list the tree.
      if (byPath.size === 0) {
        const tree = await source.listTree(repoOpts);
        const files = tree.entries
          .filter((e) => e.type === 'file' && isExplorableSourcePath(e.path))
          .slice(0, maxFiles);
        for (const entry of files) {
          const path = displayFilePath(entry.path);
          const file = await source.readFile({ path: entry.path, ...repoOpts });
          byPath.set(path, {
            path,
            excerpt: (file.content || '').slice(0, 800),
          });
        }
      } else {
        for (const finding of [...byPath.values()].slice(0, maxFiles)) {
          if (finding.excerpt.trim()) continue;
          const file = await source.readFile({ path: finding.path, ...repoOpts });
          finding.excerpt = (file.content || '').slice(0, 800);
        }
      }

      const details = [...byPath.values()].slice(0, maxFiles);
      const repoLabel = input.repo?.trim() || 'bound repository';
      if (details.length === 0) {
        return {
          summary: `source-repo searched ${repoLabel} for ${input.application} before planning (${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, no file hits). Bind Azure DevOps Repos to the application source when HTML/SDK paths appear instead.`,
          findings: `searched ${repoLabel} for: ${queries.join(', ')} (no file hits)`,
          details: [],
          source: 'repo',
          repo: input.repo,
        };
      }

      const findings = details
        .map((d) => `- ${d.path}${d.query ? ` (query: ${d.query})` : ''}\n  ${d.excerpt.replace(/\s+/g, ' ').slice(0, 280)}`)
        .join('\n');
      const files = details.map((d) => d.path).join(', ');
      return {
        summary: `Visited files: ${files} for ${input.application} before planning.`,
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
      return {
        items: (out?.items ?? []).flatMap((item) => {
          const path = typeof item?.path === 'string' ? item.path : '';
          if (!path || !isExplorableSourcePath(path)) return [];
          return [{ path: displayFilePath(path), snippet: typeof item.snippet === 'string' ? item.snippet : '' }];
        }),
      };
    },
    async listTree(input) {
      const body: Record<string, unknown> = {};
      if (input?.path) body.path = input.path;
      if (input?.repo) body.repo = input.repo;
      if (input?.branch) body.branch = input.branch;
      const out = await invoke('scm.tree.list', body) as { entries?: { path?: string; type?: string }[] };
      return {
        entries: (out?.entries ?? []).flatMap((e) => {
          const p = typeof e.path === 'string' ? e.path : '';
          if (!p || (e.type !== 'dir' && !isExplorableSourcePath(p))) return [];
          return [{ path: p, type: e.type === 'dir' ? 'dir' as const : 'file' as const }];
        }),
      };
    },
    async readFile(input) {
      const body: Record<string, unknown> = { path: input.path };
      if (input.repo) body.repo = input.repo;
      if (input.branch) body.branch = input.branch;
      const out = await invoke('scm.file.read', body) as { path?: string; content?: string; truncated?: boolean };
      return {
        path: typeof out?.path === 'string' ? out.path : input.path,
        content: typeof out?.content === 'string' ? out.content : '',
        truncated: Boolean(out?.truncated),
      };
    },
  };
}
