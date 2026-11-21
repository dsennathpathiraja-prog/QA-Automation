import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { createCodeExplorer, searchQueriesFor, sourceRepoPortFromInvoker } from '../src/code-explorer';
import type { SourceRepoPort } from '../src/types';

describe('searchQueriesFor', () => {
  it('extracts tokens from criteria and drops stop words', () => {
    expect(searchQueriesFor('PayNSure', ['The saved card is listed on the payment page'])).toEqual(
      expect.arrayContaining(['paynsure', 'saved', 'card', 'listed', 'payment', 'page']),
    );
  });
});

describe('code explorer', () => {
  it('skips when no source-repo connector is bound', async () => {
    const out = await createCodeExplorer(undefined).explore({
      application: 'PayNSure',
      criteria: ['saved card'],
    });
    expect(out.source).toBe('skipped');
    expect(out.summary).toMatch(/no source repository connector/i);
  });

  it('searches and records file excerpts before planning', async () => {
    const calls: string[] = [];
    const source: SourceRepoPort = {
      async search(query) {
        calls.push(`search:${query}`);
        return { items: [{ path: 'src/pay/CardList.tsx', snippet: 'export function CardList() { return <ul />; }' }] };
      },
      async listTree() {
        calls.push('tree');
        return { entries: [] };
      },
      async readFile(path) {
        calls.push(`read:${path}`);
        return { path, content: 'full file', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      criteria: ['The saved card is listed'],
      maxFiles: 4,
    });
    expect(out.source).toBe('repo');
    expect(out.details[0]?.path).toBe('src/pay/CardList.tsx');
    expect(out.findings).toMatch(/CardList/);
    expect(calls.some((c) => c.startsWith('search:'))).toBe(true);
  });

  it('falls back to tree listing when search returns nothing', async () => {
    const source: SourceRepoPort = {
      async search() { return { items: [] }; },
      async listTree() {
        return { entries: [{ path: 'README.md', type: 'file' }, { path: 'src', type: 'dir' }] };
      },
      async readFile(path) {
        return { path, content: '# Shop checkout', truncated: false };
      },
    };
    const out = await createCodeExplorer(source).explore({
      application: 'checkout',
      criteria: [],
    });
    expect(out.source).toBe('repo');
    expect(out.details).toEqual([{ path: 'README.md', excerpt: '# Shop checkout' }]);
  });

  it('skips when the connector denies the source-repo role', async () => {
    const source = sourceRepoPortFromInvoker(async () => {
      throw new PlatformError('denied', 'No source-repo connector is bound');
    });
    const out = await createCodeExplorer(source).explore({
      application: 'PayNSure',
      criteria: ['card'],
    });
    expect(out.source).toBe('skipped');
    expect(out.summary).toMatch(/could not be read/);
  });
});
