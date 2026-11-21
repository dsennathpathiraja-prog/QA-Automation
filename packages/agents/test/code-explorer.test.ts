import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { createCodeExplorer, sourceRepoPortFromInvoker } from '../src/code-explorer';
import type { SourceRepoPort } from '../src/types';

describe('code explorer', () => {
  it('fails when no source-repo port is bound', async () => {
    await expect(createCodeExplorer(undefined).explore({
      application: 'PayNSure',
      workItem: '7189',
      criteria: ['saved card'],
    })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('searches the bound repo and reads matching files', async () => {
    const calls: string[] = [];
    const repo: SourceRepoPort = {
      async search({ query }) {
        calls.push(`search:${query}`);
        if (query.includes('card') || query.includes('pay')) {
          return [{ path: 'src/Pay.tsx', snippet: 'saved card' }];
        }
        return [];
      },
      async readFile({ path }) {
        calls.push(`read:${path}`);
        return { path, content: 'export function Pay() { return "saved card"; }', truncated: false };
      },
    };
    const out = await createCodeExplorer(repo).explore({
      application: 'PayNSure',
      workItem: '7189',
      criteria: ['The saved card is listed'],
      repo: 'shop',
    });
    expect(out.source).toBe('repo');
    expect(out.details[0]?.path).toBe('src/Pay.tsx');
    expect(out.summary).toMatch(/source-repo read/);
    expect(calls.some((c) => c.startsWith('search:'))).toBe(true);
    expect(calls).toContain('read:src/Pay.tsx');
  });

  it('omits repo from invoke when relying on connector-bound config', async () => {
    const payloads: { capability: string; input: Record<string, unknown> }[] = [];
    const port = sourceRepoPortFromInvoker(async (capability, input) => {
      payloads.push({ capability, input: input ?? {} });
      if (capability === 'scm.code.search') return { items: [{ path: 'a.ts', snippet: 'login' }] };
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
