import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { browserPortFromInvoker, createBrowserExplorer } from '../src/browser-explorer';
import type { BrowserAutomationPort } from '../src/types';

describe('browser explorer', () => {
  it('skips when no environment URL is given', async () => {
    const out = await createBrowserExplorer(undefined).explore({
      application: 'PayNSure',
      scenarios: [],
    });
    expect(out.source).toBe('skipped');
    expect(out.summary).toMatch(/no environment/);
  });

  it('navigates and records snapshot excerpts', async () => {
    const calls: string[] = [];
    const browser: BrowserAutomationPort = {
      async openSession() { calls.push('open'); },
      async navigate(url) { calls.push(`nav:${url}`); return { finalUrl: url }; },
      async snapshot() { return { accessibilityTree: 'button "Pay"', url: 'https://shop.example.com/pay' }; },
      async screenshot() { return { artifactBase64: 'abc' }; },
      async closeSession() { calls.push('close'); },
    };
    const out = await createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'https://shop.example.com/pay',
      scenarios: [{
        name: 'Positive: pay',
        kind: 'positive',
        priority: 'medium',
        criterion: 'pay',
        steps: 'pay',
        expected: 'ok',
      }],
    });
    expect(out.source).toBe('browser');
    expect(out.details[0]?.snapshotExcerpt).toMatch(/Pay/);
    expect(out.summary).toMatch(/Visited https:\/\/shop\.example\.com\/pay/);
    expect(calls).toEqual(['open', 'nav:https://shop.example.com/pay', 'close']);
  });

  it('skips when the connector denies the browser role', async () => {
    const browser = browserPortFromInvoker(async () => {
      throw new PlatformError('denied', 'No browser connector is bound');
    });
    const out = await createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'https://shop.example.com',
      scenarios: [],
    });
    expect(out.source).toBe('skipped');
    expect(out.summary).toMatch(/could not open/);
  });
});
