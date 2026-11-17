import ts from 'typescript';

export interface Finding {
  kind: 'import' | 'fetch-call';
  specifier: string;
  line: number;
}

/** Extracts every module specifier (static, dynamic, require) and global `fetch(...)` call. */
export function analyzeSource(fileName: string, text: string): Finding[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true);
  const out: Finding[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push({ kind: 'import', specifier: n.moduleSpecifier.text, line: line(n) });
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const arg = n.arguments[0];
      if ((callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) && arg && ts.isStringLiteralLike(arg)) {
        out.push({ kind: 'import', specifier: arg.text, line: line(n) });
      }
      if (ts.isIdentifier(callee) && callee.text === 'fetch') out.push({ kind: 'fetch-call', specifier: 'fetch', line: line(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'undici', 'axios', 'node-fetch', 'got', 'ws', 'child_process'];
export const FS_MODULES = ['fs', 'fs/promises'];
export const GIT_WRITE_MODULES = ['simple-git', 'isomorphic-git', 'nodegit', '@octokit/rest', '@octokit/core', 'octokit'];

const bare = (s: string) => s.replace(/^node:/, '');
export const isNetwork = (s: string) => NETWORK_MODULES.includes(bare(s)) || NETWORK_MODULES.includes(bare(s).split('/')[0]!);
export const isFs = (s: string) => FS_MODULES.includes(bare(s));
export const isGitWrite = (s: string) => GIT_WRITE_MODULES.includes(s) || s.startsWith('@octokit/');

/** Allowed workspace dependencies per package (dependency rule: inward only). */
export const ALLOWED_WORKSPACE_DEPS: Record<string, readonly string[]> = {
  domain: [],
  contracts: ['domain'],
  'connector-sdk': ['domain', 'contracts'],
  security: ['domain'],
  llm: ['domain'],
  infrastructure: ['domain', 'connector-sdk', 'llm'],
  testing: ['domain', 'connector-sdk', 'security', 'infrastructure'],
  web: ['contracts'],
  api: ['contracts', 'domain', 'security', 'infrastructure', 'persistence', 'llm'],
  // Declared ahead of time so the rules exist before the packages do.
  agents: ['domain', 'contracts', 'connector-sdk', 'llm'],
  'workflow-definitions': ['domain', 'contracts', 'connector-sdk', 'agents'],
  'workflow-engine': ['domain', 'contracts', 'workflow-definitions', 'connector-sdk'],
  application: ['domain', 'contracts', 'connector-sdk', 'security', 'workflow-definitions'],
  persistence: ['domain', 'security', 'connector-sdk', 'llm', 'application'],
  worker: ['*'],
};

/** Packages that may use network, process and filesystem APIs. */
export const IO_PACKAGES = new Set(['infrastructure', 'testing', 'persistence']);
/** Browser code calls the platform API with fetch; Node network and process modules stay forbidden for it. */
export const BROWSER_PACKAGES = new Set(['web']);
export const NO_FS_PACKAGES = new Set(['llm', 'web', 'domain', 'contracts', 'connector-sdk', 'security', 'api', 'agents', 'workflow-engine', 'workflow-definitions', 'application']);
