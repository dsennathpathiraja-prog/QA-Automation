import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { browserPortFromInvoker, createBrowserExplorer } from '../src/browser-explorer';
import { DOM_PROBE_SCRIPT } from '../src/dom-probe';
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

const EMPTY_TREE = `
### Page state
- Page URL: http://sdk.paynsure.internal/shop
- Page Title: 
- Page Snapshot:
\`\`\`yaml
\`\`\`
`;

const SHOP_PROBE = {
  url: 'http://sdk.paynsure.internal/shop',
  title: 'Metro Mobile Store',
  readyState: 'complete',
  bodyText: 'Metro Mobile Store Search products Add to cart Proceed to checkout Merchant ID 97',
  headings: ['Metro Mobile Store', 'Order summary'],
  buttons: ['Add to cart', 'Proceed to checkout'],
  links: ['Kitchen', 'Travel', 'Home'],
  fields: ['Search products'],
  iframes: [],
  frameDocs: [],
};

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

  it('recovers PayNSure shop cues via DOM evaluate when aria snapshot is empty', async () => {
    let evaluated = false;
    const browser: BrowserAutomationPort = {
      async openSession() {},
      async navigate(url) { return { finalUrl: url }; },
      async waitFor() {},
      async snapshot() {
        return { accessibilityTree: EMPTY_TREE, url: 'http://sdk.paynsure.internal/shop', title: '' };
      },
      async evaluate({ script }) {
        evaluated = true;
        expect(script).toContain('querySelectorAll');
        return {
          resultText: JSON.stringify(SHOP_PROBE),
          url: SHOP_PROBE.url,
          title: SHOP_PROBE.title,
        };
      },
      async screenshot() { return { artifactBase64: '' }; },
      async closeSession() {},
    };
    const out = await createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'http://sdk.paynsure.internal/shop',
      scenarios: [],
    });
    expect(evaluated).toBe(true);
    expect(out.details[0]?.snapshotExcerpt).toMatch(/Add to cart/);
    expect(out.details[0]?.cuesSummary).toMatch(/Proceed to checkout|Search products|Metro Mobile/i);
    expect(out.findings).toMatch(/Add to cart|Proceed to checkout/);
  });

  it('fails when snapshots stay empty after retries (not Done with empty MD)', async () => {
    const browser: BrowserAutomationPort = {
      async openSession() {},
      async navigate(url) { return { finalUrl: url }; },
      async waitFor() {},
      async snapshot() { return { accessibilityTree: '', url: 'http://sdk.paynsure.internal/shop' }; },
      async evaluate() {
        return {
          resultText: JSON.stringify({
            url: 'http://sdk.paynsure.internal/shop',
            title: '',
            readyState: 'complete',
            bodyText: '',
            headings: [],
            buttons: [],
            links: [],
            fields: [],
            iframes: [],
            frameDocs: [],
          }),
        };
      },
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

  it('names DNS / extra_hosts when Chromium hit an error page', async () => {
    const browser: BrowserAutomationPort = {
      async openSession() {},
      async navigate(url) { return { finalUrl: url }; },
      async waitFor() {},
      async snapshot() { return { accessibilityTree: '', url: 'chrome-error://chromewebdata/' }; },
      async evaluate() {
        return {
          resultText: JSON.stringify({
            url: 'chrome-error://chromewebdata/',
            title: '',
            readyState: 'complete',
            bodyText: 'This site can’t be reached ERR_NAME_NOT_RESOLVED',
            headings: [],
            buttons: [],
            links: [],
            fields: [],
            iframes: [],
            frameDocs: [],
            loadError: 'browser_error_page',
          }),
        };
      },
      async screenshot() { return { artifactBase64: '' }; },
      async closeSession() {},
    };
    await expect(createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'http://sdk.paynsure.internal/shop',
      scenarios: [],
    })).rejects.toMatchObject({
      errorClass: 'transient',
      message: expect.stringMatching(/PLAYWRIGHT_MCP_SHOP_IP|extra_hosts|DNS|did not load|verify-playwright-shop-dns/i),
    });
  });

  it('fails fast with DNS guidance when navigate returns chrome-error URL', async () => {
    const browser: BrowserAutomationPort = {
      async openSession() {},
      async navigate(url) {
        return {
          finalUrl: 'chrome-error://chromewebdata/',
          accessibilityTree: '### Page state\n- Page URL: chrome-error://chromewebdata/\n- Page Title: \n',
        };
      },
      async waitFor() {},
      async snapshot() { return { accessibilityTree: '', url: 'chrome-error://chromewebdata/' }; },
      async screenshot() { return { artifactBase64: '' }; },
      async closeSession() {},
    };
    await expect(createBrowserExplorer(browser).explore({
      application: 'PayNSure',
      url: 'http://sdk.paynsure.internal/shop',
      scenarios: [],
    })).rejects.toMatchObject({
      errorClass: 'transient',
      message: expect.stringMatching(/did not load|PLAYWRIGHT_MCP_SHOP_IP|verify-playwright-shop-dns/i),
    });
  });

  it('passes sessionId from open through navigate, wait, evaluate, and close', async () => {
    const payloads: { capability: string; input: Record<string, unknown> }[] = [];
    const browser = browserPortFromInvoker(async (capability, input) => {
      payloads.push({ capability, input: input ?? {} });
      if (capability === 'browser.session.open') return { sessionId: 'sess-1' };
      if (capability === 'browser.navigate') return { finalUrl: String(input?.url ?? ''), accessibilityTree: RICH_TREE, title: 'Shop' };
      if (capability === 'browser.wait') return { ok: true };
      if (capability === 'browser.evaluate') return { resultText: '{}' };
      if (capability === 'browser.snapshot') return { accessibilityTree: RICH_TREE, url: 'https://shop.example.com', title: 'Shop' };
      if (capability === 'browser.screenshot') return { artifactBase64: '' };
      return { ok: true };
    });
    await browser.openSession();
    await browser.navigate('https://shop.example.com');
    await browser.waitFor?.({ timeSeconds: 1 });
    await browser.evaluate?.({ script: DOM_PROBE_SCRIPT });
    await browser.snapshot();
    await browser.screenshot();
    await browser.closeSession();
    expect(payloads.find((p) => p.capability === 'browser.navigate')?.input).toMatchObject({ sessionId: 'sess-1', url: 'https://shop.example.com' });
    expect(payloads.find((p) => p.capability === 'browser.wait')?.input).toMatchObject({ sessionId: 'sess-1' });
    expect(payloads.find((p) => p.capability === 'browser.evaluate')?.input).toMatchObject({ sessionId: 'sess-1' });
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
