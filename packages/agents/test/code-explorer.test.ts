import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { createCodeExplorer, displayFilePath, isHumanFilePath, searchQueriesFor, sourceRepoPortFromInvoker } from '../src/code-explorer';
import type { SourceRepoPort } from '../src/types';

describe('searchQueriesFor', () => {
  it('extracts tokens from criteria and drops stop words', () => {
    expect(searchQueriesFor('PayNSure', ['The saved card is listed on the payment page'])).toEqual(
      expect.arrayContaining(['paynsure', 'saved', 'card', 'listed', 'payment', 'page']),
    );
  });
});

describe('human file paths', () => {
  it('rejects bare git SHAs and normalizes leading slashes', () => {
    expect(isHumanFilePath('a1b2c3d4e5f6789012345678901234567890abcd')).toBe(false);
    expect(isHumanFilePath('abcdef0')).toBe(false);
    expect(isHumanFilePath('src/pay/CardList.tsx')).toBe(true);
    expect(displayFilePath('/src/pay/CardList.tsx')).toBe('src/pay/CardList.tsx');
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

  it('searches the bound repo and records file excerpts', async () => {
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
    expect(out.details[0]?.path).toBe('src/pay/CardList.tsx');
    expect(out.findings).toMatch(/CardList/);
    expect(out.summary).toMatch(/Visited files: src\/pay\/CardList\.tsx/);
    expect(calls.some((c) => c.startsWith('search:'))).toBe(true);
  });

  it('falls back to tree listing when search returns nothing', async () => {
    const source: SourceRepoPort = {
      async search() { return { items: [] }; },
      async listTree() {
        return { entries: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'dir' }] };
      },
      async readFile({ path }) {
        return { path, content: '# Shop checkout', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'checkout',
      criteria: [],
    });
    expect(out.source).toBe('repo');
    expect(out.details).toEqual([{ path: 'README.md', excerpt: '# Shop checkout' }]);
    expect(out.summary).toMatch(/Visited files: README\.md/);
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
