import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { browserPortFromInvoker, createBrowserExplorer } from '../src/browser-explorer';
import type { BrowserAutomationPort } from '../src/types';

const RICH_TREE = `
### Page state
- Page URL: https://shop.example.com/pay
- Page Title: Pay
- Page Snapshot:
\`\`\`yaml
- button "Pay" [ref=e1]
- link "Help" [ref=e2]
\`\`\`
`;

describe('browser explorer', () => {
  it('fails when no environment URL is given', async () => {
    await expect(createBrowserExplorer(undefined).explore({
      application: 'PayNSure',
      scenarios: [],
    })).rejects.toMatchObject({ errorClass: 'validation' });
  });

  it('fails when no browser connector is bound', async () => {
    await expect(createBrowserExplorer(undefined).explore({
      application: 'PayNSure',
      url: 'https://shop.example.com/pay',
      scenarios: [],
    })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('navigates and records snapshot excerpts', async () => {
    const calls: string[] = [];
    const browser: BrowserAutomationPort = {
      async openSession() { calls.push('open'); },
      async navigate(url) { calls.push(`nav:${url}`); return { finalUrl: url, accessibilityTree: RICH_TREE, title: 'Pay' }; },
      async snapshot() { return { accessibilityTree: RICH_TREE, url: 'https://shop.example.com/pay', title: 'Pay' }; },
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
    expect(out.details[0]?.title).toBe('Pay');
    expect(out.summary).toMatch(/Visited https:\/\/shop\.example\.com\/pay/);
    expect(calls).toEqual(['open', 'nav:https://shop.example.com/pay', 'close']);
  });

  it('fails when snapshots stay empty after retries (not Done with empty MD)', async () => {
    const browser: BrowserAutomationPort = {
      async openSession() {},
      async navigate(url) { return { finalUrl: url }; },
      async waitFor() {},
      async snapshot() { return { accessibilityTree: '', url: 'http://sdk.paynsure.internal/shop' }; },
      async screenshot() { return { artifactBase64: '' }; },
      async closeSession() {},
    };
    await expect(createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'http://sdk.paynsure.internal/shop',
      scenarios: [],
    })).rejects.toMatchObject({
      errorClass: 'transient',
      message: expect.stringMatching(/snapshot content is empty|not useful for test planning/i),
    });
  });

  it('passes sessionId from open through navigate and close', async () => {
    const payloads: { capability: string; input: Record<string, unknown> }[] = [];
    const browser = browserPortFromInvoker(async (capability, input) => {
      payloads.push({ capability, input: input ?? {} });
      if (capability === 'browser.session.open') return { sessionId: 'sess-1' };
      if (capability === 'browser.navigate') return { finalUrl: String(input?.url ?? ''), accessibilityTree: RICH_TREE, title: 'Shop' };
      if (capability === 'browser.snapshot') return { accessibilityTree: RICH_TREE, url: 'https://shop.example.com', title: 'Shop' };
      if (capability === 'browser.screenshot') return { artifactBase64: '' };
      return { ok: true };
    });
    await browser.openSession();
    await browser.navigate('https://shop.example.com');
    await browser.snapshot();
    await browser.screenshot();
    await browser.closeSession();
    expect(payloads.find((p) => p.capability === 'browser.navigate')?.input).toMatchObject({ sessionId: 'sess-1', url: 'https://shop.example.com' });
    expect(payloads.find((p) => p.capability === 'browser.snapshot')?.input).toMatchObject({ sessionId: 'sess-1' });
    expect(payloads.find((p) => p.capability === 'browser.session.close')?.input).toMatchObject({ sessionId: 'sess-1' });
  });

  it('fails when the connector denies the browser role', async () => {
    const browser = browserPortFromInvoker(async () => {
      throw new PlatformError('denied', 'No browser connector is bound');
    });
    await expect(createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'https://shop.example.com',
      scenarios: [],
    })).rejects.toMatchObject({ errorClass: 'denied' });
  });

  it('fails when navigate hits an allowlist error', async () => {
    const browser = browserPortFromInvoker(async (capability) => {
      if (capability === 'browser.session.open') return { sessionId: 'sess-1' };
      throw new PlatformError('denied', 'The browser may not open https://shop.example.com. Add it to the application addresses for this connector.');
    });
    await expect(createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'https://shop.example.com/checkout',
      scenarios: [],
    })).rejects.toMatchObject({ errorClass: 'denied' });
  });
});
