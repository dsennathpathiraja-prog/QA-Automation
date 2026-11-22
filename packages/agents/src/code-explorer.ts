import { PlatformError } from '@qa/domain';
import { analyzeWorkItemStory } from './story-scenarios';
import type { CodeExploreRequest, CodeExploreResult, CodeExplorerPort, CodeFinding, SourceRepoPort } from './types';

const SEARCH_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'as', 'by',
  'from', 'that', 'this', 'it', 'user', 'should', 'must', 'can', 'will', 'when', 'then', 'given',
  'acceptance', 'criteria', 'description', 'notes', 'repro', 'steps', 'verify', 'application',
  'work', 'item', 'title', 'business', 'requirements',
]);

const normalizeToken = (w: string) => w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

const appTokens = (application?: string): Set<string> => {
  const out = new Set<string>();
  for (const part of (application || '').toLowerCase().split(/[^a-z0-9]+/)) {
    const t = normalizeToken(part);
    if (t.length >= 3) out.add(t);
  }
  return out;
};

/** Phrase-ish queries from criteria lines (e.g. "paid amount", "notification template"). */
function phraseQueries(criteria: string[]): string[] {
  const out: string[] = [];
  for (const line of criteria) {
    const cleaned = line
      .toLowerCase()
      .replace(/[*_#>`\[\]()]/g, ' ')
      .replace(/[^a-z0-9_\-./\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length < 6) continue;
    const words = cleaned.split(' ').map(normalizeToken).filter((w) => w.length >= 3 && !SEARCH_STOP.has(w));
    if (words.length >= 2) {
      const phrase = words.slice(0, 4).join(' ');
      if (phrase.length >= 6) out.push(phrase);
    }
  }
  return out;
}

/**
 * Derive SCM search queries from work item title / description / AC — never from the
 * application/product name alone (e.g. do not search only `paynsure`).
 */
export function searchQueriesFor(
  applicationOrInput: string | { story?: string; criteria?: string[]; workItemTitle?: string; application?: string },
  criteriaMaybe?: string[],
): string[] {
  // Back-compat: searchQueriesFor(application, criteria)
  const input = typeof applicationOrInput === 'string'
    ? { application: applicationOrInput, criteria: criteriaMaybe ?? [] }
    : applicationOrInput;

  const criteria = input.criteria ?? [];
  const storyBlob = [input.workItemTitle, input.story, ...criteria].filter(Boolean).join('\n');
  const product = appTokens(input.application);

  const words = storyBlob
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\s]+/g, ' ')
    .split(/\s+/)
    .map(normalizeToken)
    .filter((w) => w.length >= 3 && !SEARCH_STOP.has(w) && !product.has(w));

  const unique = [...new Set(words)];
  const phrases = phraseQueries(criteria).filter((p) => {
    const parts = p.split(' ');
    return !parts.every((part) => product.has(part));
  });

  // Prefer phrases then distinctive tokens (escrow, notification, template, amount, …).
  const queries = [...new Set([...phrases, ...unique])].slice(0, 8);
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

/** Empty or path-only snippets must not drive scenarios. */
export function isMeaningfulCodeExcerpt(excerpt: string | undefined): boolean {
  const text = (excerpt ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 12) return false;
  // Reject path-only / filename-only dumps.
  if (/^[\w./\-]+$/.test(text) && text.length < 80 && !/\s/.test(text) && !/[{;=()]/.test(text)) return false;
  if (/^(file|path|src|lib|dist)\b/i.test(text) && text.length < 24) return false;
  return true;
}

/**
 * True when consolidated or raw code-explore findings are noise (app-name search,
 * empty path lists, SDK path dumps without usable snippets).
 */
export function isCodeExploreNoise(findings?: string): boolean {
  const raw = (findings ?? '').trim();
  if (!raw) return true;
  if (/no file hits|not relevant|noise|empty excerpt|path-only/i.test(raw)) return true;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const pathLines = lines.filter((l) => /^-\s+[\w./\-]+/.test(l));
  if (pathLines.length === 0) return /repository not read|no usable|searched .+\(no/i.test(raw);
  const excerptLines = lines.filter((l) => l.startsWith(' ') || (!l.startsWith('-') && isMeaningfulCodeExcerpt(l)));
  const meaningful = excerptLines.filter((l) => isMeaningfulCodeExcerpt(l.replace(/^\s+/, '')));
  if (meaningful.length === 0) return true;
  return false;
}

/**
 * Read-only source explorer. Prefer a bound Azure DevOps Repos connector (real app
 * source) over GitHub/HTML SDK trees. Searches and reads matching files BEFORE the
 * planner so findings feed the Markdown plan. Failures throw — Explore code must
 * succeed with a real connector call.
 * Queries come from WI title/description/AC — never application name alone.
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

      const analysis = analyzeWorkItemStory({
        story: input.story || '',
        criteria: input.criteria,
        workItemTitle: input.workItemTitle,
        application: input.application,
      });
      const fromStory = analysis.searchTerms;
      const fromLegacy = searchQueriesFor({
        application: input.application,
        criteria: input.criteria ?? [],
        story: input.story,
        workItemTitle: input.workItemTitle,
      });
      const queries = [...new Set([...fromStory, ...fromLegacy])]
        .filter((q) => q.toLowerCase() !== (input.application || '').toLowerCase())
        .slice(0, input.maxQueries ?? 8);

      const repoOpts = input.repo ? { repo: input.repo } : {};
      const repoLabel = input.repo?.trim() || 'bound repository';

      if (queries.length === 0) {
        return {
          summary: `Explore code skipped product-name-only search for ${input.application}; no WI title/description/AC tokens to query in ${repoLabel}. Prefer story-grounded scenarios.`,
          findings: `Code explore not relevant: no story-derived search terms (refusing application-only query "${input.application}").`,
          details: [],
          source: 'repo',
          repo: input.repo,
          relevant: false,
          warning: 'Code explore had no work-item-derived search terms — do not query by application name alone; prefer story-grounded scenarios.',
        };
      }

      const maxFiles = Math.min(Math.max(1, input.maxFiles ?? 12), 40);
      const byPath = new Map<string, CodeFinding>();

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

      const withContent = [...byPath.values()]
        .filter((d) => isMeaningfulCodeExcerpt(d.excerpt))
        .slice(0, maxFiles);

      if (withContent.length === 0) {
        const pathOnly = [...byPath.values()].map((d) => d.path).slice(0, 12);
        const note = pathOnly.length > 0
          ? `path-only hits (no usable excerpts): ${pathOnly.join(', ')}`
          : 'no file hits';
        return {
          summary: `source-repo searched ${repoLabel} for story terms [${queries.join(', ')}] before planning — ${note}. Prefer story-grounded scenarios.`,
          findings: `Code explore not relevant: searched ${repoLabel} for: ${queries.join(', ')} (${note}). Empty path-only hits must not drive scenarios.`,
          details: [],
          source: 'repo',
          repo: input.repo,
          relevant: false,
          warning: 'Code explore returned empty/path-only hits — prefer story-grounded scenarios; do not invent cases from path lists.',
        };
      }

      const findings = withContent
        .map((d) => `- ${d.path}${d.query ? ` (query: ${d.query})` : ''}\n  ${d.excerpt.replace(/\s+/g, ' ').slice(0, 280)}`)
        .join('\n');
      const files = withContent.map((d) => d.path).join(', ');
      return {
        summary: `Visited files: ${files} for ${input.application} before planning (queries: ${queries.join(', ')}).`,
        findings,
        details: withContent,
        source: 'repo',
        repo: input.repo,
        relevant: true,
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
