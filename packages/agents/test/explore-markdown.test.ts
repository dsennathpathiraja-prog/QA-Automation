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
});
