import { describe, expect, it } from 'vitest';
import { renderExploreUiMarkdown } from '../src/explore-markdown';

describe('renderExploreUiMarkdown', () => {
  it('surfaces YAML a11y tree and cues instead of a one-line _(empty)_', () => {
    const md = renderExploreUiMarkdown({
      workItem: '2357',
      application: 'PayNSure',
      findings: '- Explore: PayNSure @ http://sdk.paynsure.internal/shop\n  title="PayNSure Shop"; buttons="Checkout"',
      details: [{
        scenarioName: 'Explore: PayNSure',
        url: 'http://sdk.paynsure.internal/shop',
        title: 'PayNSure Shop',
        snapshotExcerpt: `
### Page state
- Page URL: http://sdk.paynsure.internal/shop
- Page Title: PayNSure Shop
- Page Snapshot:
\`\`\`yaml
- heading "PayNSure" [ref=e1]
- button "Checkout" [ref=e2]
\`\`\`
`,
        screenshotBase64: 'abc',
      }],
    });
    expect(md).toMatch(/PayNSure Shop/);
    expect(md).toMatch(/```yaml/);
    expect(md).toMatch(/button "Checkout"/);
    expect(md).toMatch(/\*\*Buttons:\*\*/);
    expect(md).toMatch(/Screenshot:\*\* captured/);
    expect(md).not.toMatch(/_\(empty\)_/);
  });

  it('lists multi-page explore progress and click findings for operators', () => {
    const md = renderExploreUiMarkdown({
      workItem: 'QA-79',
      application: 'PayNSure',
      findings: 'Explored 2 pages: https://shop.example/shop, https://shop.example/cart\n\nClick findings:\n- Clicked button "Kitchen" → heading changed [captured]',
      pagesVisited: 2,
      exploredUrls: ['https://shop.example/shop', 'https://shop.example/cart'],
      clickOutcomes: [{
        control: 'Kitchen',
        kind: 'button',
        urlBefore: 'https://shop.example/shop',
        urlAfter: 'https://shop.example/shop',
        headingBefore: 'All items',
        headingAfter: 'Kitchen',
        changeSummary: 'URL unchanged; heading "All items" → "Kitchen"; cues/region changed',
        changed: true,
        disabledBefore: ['Proceed to checkout'],
        disabledAfter: ['Proceed to checkout'],
        result: 'captured',
      }],
      details: [
        {
          scenarioName: 'Explore: shop',
          url: 'https://shop.example/shop',
          snapshotExcerpt: '- button "Cart"',
        },
        {
          scenarioName: 'Explore via link: Cart',
          url: 'https://shop.example/cart',
          snapshotExcerpt: '- button "Checkout"',
          viaClick: 'Cart',
        },
      ],
    });
    expect(md).toMatch(/## Multi-page explore/);
    expect(md).toMatch(/Pages explored:\*\* 2/);
    expect(md).toMatch(/## Click findings/);
    expect(md).toMatch(/Clicked button `Kitchen`/);
    expect(md).toMatch(/All items/);
    expect(md).toMatch(/Disabled before/);
    expect(md).toMatch(/shop\.example\/cart/);
  });
});
