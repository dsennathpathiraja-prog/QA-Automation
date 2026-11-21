import { describe, expect, it } from 'vitest';
import {
  describeEmptyCapture,
  domProbeIsActionable,
  parseEvaluateToolResult,
  parsedSnapshotFromDomProbe,
  yamlFromDomProbe,
  type DomProbeResult,
} from '../src/dom-probe';
import { snapshotIsActionable, summarizeSnapshotForFindings } from '../src/snapshot-content';

const SHOP_PROBE: DomProbeResult = {
  url: 'http://sdk.paynsure.internal/shop',
  title: 'Metro Mobile Store',
  readyState: 'complete',
  bodyText:
    'Metro Mobile Store Ship to Sri Lanka Currency LKR Signed in as Prineth Fernando Search products All items Kitchen Travel Home Desk Everyday Add to cart Order summary Proceed to checkout PayNSure Merchant ID 97',
  headings: ['Metro Mobile Store', 'Order summary'],
  buttons: ['Add to cart', 'Proceed to checkout'],
  links: ['All items', 'Kitchen', 'Travel', 'Home', 'Desk', 'Everyday'],
  fields: ['Search products', 'Currency LKR'],
  iframes: [],
  frameDocs: [],
};

describe('dom-probe', () => {
  it('parses browser_evaluate Result JSON into a PayNSure-like storefront probe', () => {
    const toolText = `### Result
${JSON.stringify(SHOP_PROBE, null, 2)}

### Page state
- Page URL: http://sdk.paynsure.internal/shop
- Page Title: Metro Mobile Store
- Page Snapshot:
\`\`\`yaml
\`\`\`
`;
    const probe = parseEvaluateToolResult(toolText);
    expect(probe?.title).toBe('Metro Mobile Store');
    expect(probe?.buttons).toContain('Add to cart');
    expect(domProbeIsActionable(probe)).toBe(true);
    const parsed = parsedSnapshotFromDomProbe(probe!);
    expect(snapshotIsActionable(parsed)).toBe(true);
    expect(yamlFromDomProbe(probe!)).toMatch(/button "Add to cart"/);
    expect(summarizeSnapshotForFindings(parsed)).toMatch(/Proceed to checkout/);
  });

  it('flags Chromium DNS / error pages as non-actionable with a clear reason', () => {
    const probe: DomProbeResult = {
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
    };
    expect(domProbeIsActionable(probe)).toBe(false);
    expect(describeEmptyCapture({ url: 'http://sdk.paynsure.internal/shop', probe })).toMatch(/PLAYWRIGHT_MCP_SHOP_IP|extra_hosts|DNS|verify-playwright-shop-dns/i);
  });

  it('names opaque iframe shells when no same-origin controls exist', () => {
    const probe: DomProbeResult = {
      url: 'http://sdk.paynsure.internal/shop',
      title: 'Shop',
      readyState: 'complete',
      bodyText: '',
      headings: [],
      buttons: [],
      links: [],
      fields: [],
      iframes: [{ src: 'https://pay.example/embed', name: 'pay', title: '', width: 400, height: 600 }],
      frameDocs: [],
    };
    expect(describeEmptyCapture({ url: probe.url, title: probe.title, probe })).toMatch(/iframe/i);
  });
});
