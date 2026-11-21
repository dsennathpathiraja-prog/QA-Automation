import { isPlatformError } from '@qa/domain';
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
 * In-repo explorer that drives the bound source-repo connector (GitHub / Azure DevOps)
 * before the planner. Skips cleanly when no connector is available so RV runs stay usable.
 */
export function createCodeExplorer(source: SourceRepoPort | undefined): CodeExplorerPort {
  return {
    async explore(input: CodeExploreRequest): Promise<CodeExploreResult> {
      if (!source) {
        return {
          summary: `Source note for ${input.application}: no source repository connector is bound, so the repository was not read.`,
          findings: 'repository not read',
          details: [],
          source: 'skipped',
        };
      }

      const queries = searchQueriesFor(input.application, input.criteria ?? []);
      const maxFiles = Math.min(Math.max(1, input.maxFiles ?? 12), 40);
      const byPath = new Map<string, CodeFinding>();

      try {
        for (const query of queries) {
          if (byPath.size >= maxFiles) break;
          const found = await source.search(query);
          for (const hit of found.items) {
            if (!hit.path || byPath.has(hit.path)) continue;
            byPath.set(hit.path, {
              path: hit.path,
              excerpt: (hit.snippet || '').slice(0, 800),
              query,
            });
            if (byPath.size >= maxFiles) break;
          }
        }

        // When search returns nothing (or is partial), list the tree and read a few files.
        if (byPath.size === 0) {
          const tree = await source.listTree();
          const files = tree.entries.filter((e) => e.type === 'file').slice(0, maxFiles);
          for (const entry of files) {
            const file = await source.readFile(entry.path);
            byPath.set(entry.path, {
              path: entry.path,
              excerpt: (file.content || '').slice(0, 800),
            });
          }
        } else {
          // Enrich search hits with a short file read when the snippet is empty.
          for (const finding of [...byPath.values()].slice(0, maxFiles)) {
            if (finding.excerpt.trim()) continue;
            const file = await source.readFile(finding.path);
            finding.excerpt = (file.content || '').slice(0, 800);
          }
        }
      } catch (e) {
        if (isPlatformError(e) && (e.errorClass === 'denied' || e.errorClass === 'not-found' || e.errorClass === 'unsupported' || e.errorClass === 'auth' || e.errorClass === 'validation')) {
          return {
            summary: `Source note for ${input.application}: the source repository could not be read (${e.message}).`,
            findings: 'repository not read',
            details: [],
            source: 'skipped',
          };
        }
        throw e;
      }

      const details = [...byPath.values()].slice(0, maxFiles);
      if (details.length === 0) {
        return {
          summary: `Source note for ${input.application}: the bound repository returned no matching files for the story cues.`,
          findings: 'no matching source files',
          details: [],
          source: 'repo',
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
      };
    },
  };
}

/** Adapt ConnectorExecutionManager-style invokes into SourceRepoPort. */
export function sourceRepoPortFromInvoker(
  invoke: (capability: string, input?: Record<string, unknown>) => Promise<unknown>,
): SourceRepoPort {
  return {
    async search(query: string) {
      const out = await invoke('scm.code.search', { query }) as { items?: { path?: string; snippet?: string }[] };
      return {
        items: (out?.items ?? []).flatMap((item) => {
          const path = typeof item.path === 'string' ? item.path : '';
          if (!path) return [];
          return [{ path, snippet: typeof item.snippet === 'string' ? item.snippet : '' }];
        }),
      };
    },
    async listTree(path?: string) {
      const out = await invoke('scm.tree.list', path ? { path } : {}) as {
        entries?: { path?: string; type?: string }[];
      };
      return {
        entries: (out?.entries ?? []).flatMap((e) => {
          const p = typeof e.path === 'string' ? e.path : '';
          if (!p) return [];
          return [{ path: p, type: e.type === 'dir' ? 'dir' as const : 'file' as const }];
        }),
      };
    },
    async readFile(path: string) {
      const out = await invoke('scm.file.read', { path }) as { path?: string; content?: string; truncated?: boolean };
      return {
        path: typeof out?.path === 'string' ? out.path : path,
        content: typeof out?.content === 'string' ? out.content : '',
        truncated: Boolean(out?.truncated),
      };
    },
  };
}
