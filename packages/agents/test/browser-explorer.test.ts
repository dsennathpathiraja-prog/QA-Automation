import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { browserPortFromInvoker, createBrowserExplorer } from '../src/browser-explorer';
import type { BrowserAutomationPort } from '../src/types';

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
    expect(calls).toEqual(['open', 'nav:https://shop.example.com/pay', 'close']);
  });

  it('passes sessionId from open through navigate and close', async () => {
    const payloads: { capability: string; input: Record<string, unknown> }[] = [];
    const browser = browserPortFromInvoker(async (capability, input) => {
      payloads.push({ capability, input: input ?? {} });
      if (capability === 'browser.session.open') return { sessionId: 'sess-1' };
      if (capability === 'browser.navigate') return { finalUrl: String(input?.url ?? '') };
      if (capability === 'browser.snapshot') return { accessibilityTree: 'ok', url: 'https://shop.example.com' };
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
});
