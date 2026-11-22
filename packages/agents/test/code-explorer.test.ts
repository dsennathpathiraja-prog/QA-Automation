import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import {
  createCodeExplorer,
  displayFilePath,
  isExplorableSourcePath,
  isHumanFilePath,
  isMeaningfulCodeExcerpt,
  searchQueriesFor,
  sourceRepoPortFromInvoker,
} from '../src/code-explorer';
import type { SourceRepoPort } from '../src/types';

describe('searchQueriesFor', () => {
  it('extracts tokens from criteria and drops stop words and product name', () => {
    const q = searchQueriesFor('PayNSure', ['The saved card is listed on the payment page']);
    expect(q).toEqual(expect.arrayContaining(['saved', 'card', 'listed', 'payment', 'page']));
    expect(q).not.toContain('paynsure');
  });

  it('derives escrow/notification terms from story — never defaults to paynsure', () => {
    const q = searchQueriesFor({
      application: 'PayNSure',
      workItemTitle: 'Order Amount Placement in Escrow Notification Template',
      story: 'Email subject held in escrow. Paid Amount. Confirm Delivery.',
      criteria: ['Greeting', 'Paid Amount'],
    });
    expect(q.some((t) => /escrow|notification|paid|amount|delivery|greeting/i.test(t))).toBe(true);
    expect(q.every((t) => t.toLowerCase() !== 'paynsure')).toBe(true);
  });

  it('returns empty when only application name is available', () => {
    expect(searchQueriesFor({ application: 'PayNSure', criteria: [] })).toEqual([]);
  });
});

describe('human file paths', () => {
  it('rejects bare git SHAs and normalizes leading slashes', () => {
    expect(isHumanFilePath('a1b2c3d4e5f6789012345678901234567890abcd')).toBe(false);
    expect(isHumanFilePath('abcdef0')).toBe(false);
    expect(isHumanFilePath('src/pay/CardList.tsx')).toBe(true);
    expect(displayFilePath('/src/pay/CardList.tsx')).toBe('src/pay/CardList.tsx');
  });

  it('skips HTML and SDK documentation paths', () => {
    expect(isExplorableSourcePath('src/pay/CardList.tsx')).toBe(true);
    expect(isExplorableSourcePath('sdk/html/index.html')).toBe(false);
    expect(isExplorableSourcePath('docs/api/Client.html')).toBe(false);
    expect(isExplorableSourcePath('html-sdk/readme.md')).toBe(false);
  });

  it('rejects empty path-only excerpts', () => {
    expect(isMeaningfulCodeExcerpt('')).toBe(false);
    expect(isMeaningfulCodeExcerpt('src/a.ts')).toBe(false);
    expect(isMeaningfulCodeExcerpt('export function renderEscrowEmail() { return subject; }')).toBe(true);
  });
});

describe('code explorer', () => {
  it('fails when no source-repo port is bound', async () => {
    await expect(createCodeExplorer(undefined).explore({
      application: 'PayNSure',
      workItem: '7189',
      criteria: ['saved card'],
    })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('searches the bound repo with story terms and records file excerpts', async () => {
    const calls: string[] = [];
    const source: SourceRepoPort = {
      async search({ query }) {
        calls.push(`search:${query}`);
        return { items: [{ path: 'src/pay/CardList.tsx', snippet: 'export function CardList() { return <ul />; }' }] };
      },
      async listTree() {
        calls.push('tree');
        return { entries: [] };
      },
      async readFile({ path }) {
        calls.push(`read:${path}`);
        return { path, content: 'full file', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      workItem: '7189',
      criteria: ['The saved card is listed'],
      repo: 'shop',
      maxFiles: 4,
    });
    expect(out.source).toBe('repo');
    expect(out.relevant).toBe(true);
    expect(out.details[0]?.path).toBe('src/pay/CardList.tsx');
    expect(out.findings).toMatch(/CardList/);
    expect(out.summary).toMatch(/Visited files: src\/pay\/CardList\.tsx/);
    expect(calls.some((c) => c.startsWith('search:'))).toBe(true);
    expect(calls.every((c) => c !== 'search:PayNSure' && c !== 'search:paynsure')).toBe(true);
  });

  it('refuses application-only query when story has no tokens', async () => {
    const source: SourceRepoPort = {
      async search() { return { items: [] }; },
      async listTree() { return { entries: [] }; },
      async readFile({ path }) { return { path, content: '', truncated: false }; },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      criteria: [],
    });
    expect(out.relevant).toBe(false);
    expect(out.findings).toMatch(/not relevant|application-only/i);
  });

  it('marks path-only empty excerpts as not relevant', async () => {
    const source: SourceRepoPort = {
      async search() {
        return { items: [{ path: 'src/modal/paynsure-sdk.ts', snippet: '' }] };
      },
      async listTree() { return { entries: [] }; },
      async readFile({ path }) {
        return { path, content: '', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      story: 'Escrow notification template Paid Amount Confirm Delivery',
      workItemTitle: 'Order Amount Placement in Escrow Notification Template',
      criteria: ['Paid Amount'],
    });
    expect(out.relevant).toBe(false);
    expect(out.details).toEqual([]);
    expect(out.findings).toMatch(/path-only|not relevant/i);
  });

  it('falls back to tree listing when search returns nothing', async () => {
    const source: SourceRepoPort = {
      async search() { return { items: [] }; },
      async listTree() {
        return { entries: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'dir' }] };
      },
      async readFile({ path }) {
        return { path, content: '# Shop checkout escrow notification', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'checkout',
      criteria: ['escrow notification'],
    });
    expect(out.source).toBe('repo');
    expect(out.details[0]?.path).toBe('README.md');
    expect(out.relevant).toBe(true);
  });

  it('ignores commit SHAs from search and lists real files instead', async () => {
    const source: SourceRepoPort = {
      async search() {
        return { items: [{ path: 'a1b2c3d4e5f6789012345678901234567890abcd', snippet: 'pay fix' }] };
      },
      async listTree() {
        return { entries: [{ path: '/src/pay.ts', type: 'file' }] };
      },
      async readFile({ path }) {
        return { path, content: 'export const pay = 1', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      criteria: ['pay'],
    });
    expect(out.details.map((d) => d.path)).toEqual(['src/pay.ts']);
    expect(out.summary).toMatch(/Visited files: src\/pay\.ts/);
    expect(out.summary).not.toMatch(/a1b2c3d4/);
  });

  it('ignores HTML/SDK search hits and falls back to source files', async () => {
    const source: SourceRepoPort = {
      async search() {
        return {
          items: [
            { path: 'sdk/Client.html', snippet: '<html>SDK</html>' },
            { path: 'docs/api/index.html', snippet: 'API docs' },
          ],
        };
      },
      async listTree() {
        return { entries: [{ path: 'src/ledger.ts', type: 'file' }, { path: 'sdk/Client.html', type: 'file' }] };
      },
      async readFile({ path }) {
        return { path, content: path.endsWith('.ts') ? 'export const ledger = 1' : '<html/>', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      criteria: ['ledger'],
    });
    expect(out.details.map((d) => d.path)).toEqual(['src/ledger.ts']);
    expect(out.summary).not.toMatch(/\.html/);
  });

  it('omits repo from invoke when relying on connector-bound config', async () => {
    const payloads: { capability: string; input: Record<string, unknown> }[] = [];
    const port = sourceRepoPortFromInvoker(async (capability, input) => {
      payloads.push({ capability, input: input ?? {} });
      if (capability === 'scm.code.search') return { items: [{ path: 'a.ts', snippet: 'login' }] };
      if (capability === 'scm.tree.list') return { entries: [] };
      return { path: 'a.ts', content: 'login()', truncated: false };
    });
    await port.search({ query: 'login' });
    await port.readFile({ path: 'a.ts' });
    expect(payloads[0]).toEqual({ capability: 'scm.code.search', input: { query: 'login' } });
    expect(payloads[1]).toEqual({ capability: 'scm.file.read', input: { path: 'a.ts' } });
  });

  it('surfaces connector validation errors', async () => {
    const port = sourceRepoPortFromInvoker(async () => {
      throw new PlatformError('validation', 'invalid input for scm.code.search: repo: Required');
    });
    await expect(createCodeExplorer(port).explore({
      application: 'PayNSure',
      criteria: ['login'],
    })).rejects.toMatchObject({ errorClass: 'validation' });
  });
});
