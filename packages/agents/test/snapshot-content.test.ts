import { describe, expect, it } from 'vitest';
import {
  parseMcpPageSnapshot,
  snapshotArtifactBody,
  snapshotIsActionable,
  summarizeSnapshotForFindings,
} from '../src/snapshot-content';

const MCP_SAMPLE = `
### Page state
- Page URL: http://sdk.paynsure.internal/shop
- Page Title: PayNSure Shop
- Page Snapshot:
\`\`\`yaml
- document [ref=e1]:
  - heading "PayNSure" [level=1] [ref=e2]
  - link "Cart" [ref=e3]
  - button "Checkout" [ref=e4]
  - textbox "Search" [ref=e5]
\`\`\`
`;

describe('snapshot-content', () => {
  it('parses Playwright MCP page-state markdown into YAML and cues', () => {
    const parsed = parseMcpPageSnapshot(MCP_SAMPLE);
    expect(parsed.url).toBe('http://sdk.paynsure.internal/shop');
    expect(parsed.title).toBe('PayNSure Shop');
    expect(parsed.yaml).toMatch(/heading "PayNSure"/);
    expect(parsed.cues.buttons).toEqual(['Checkout']);
    expect(parsed.cues.links).toEqual(['Cart']);
    expect(parsed.cues.fields).toEqual(['Search']);
    expect(parsed.cues.headings).toEqual(['PayNSure']);
    expect(snapshotIsActionable(parsed)).toBe(true);
    expect(snapshotArtifactBody(parsed)).toMatch(/button "Checkout"/);
    expect(summarizeSnapshotForFindings(parsed)).toMatch(/Checkout/);
  });

  it('rejects blank / about:blank / no-tabs snapshots as non-actionable', () => {
    expect(snapshotIsActionable(parseMcpPageSnapshot(''))).toBe(false);
    expect(snapshotIsActionable(parseMcpPageSnapshot('### Open tabs\nNo open tabs. Use the "browser_navigate" tool'))).toBe(false);
    expect(snapshotIsActionable(parseMcpPageSnapshot(`
- Page URL: about:blank
- Page Title: 
- Page Snapshot:
\`\`\`yaml
\`\`\`
`))).toBe(false);
  });
});
