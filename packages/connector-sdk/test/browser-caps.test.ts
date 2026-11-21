import { describe, expect, it } from 'vitest';
import { withBrowserExploreHelpers } from '../src/browser-caps';
import type { CapabilityId } from '../src/types';

describe('withBrowserExploreHelpers', () => {
  it('grants wait+evaluate when snapshot is already permitted (post-upgrade Explore)', () => {
    const caps = withBrowserExploreHelpers(new Set<CapabilityId>(['browser.session.open', 'browser.navigate', 'browser.snapshot']));
    expect(caps.has('browser.wait')).toBe(true);
    expect(caps.has('browser.evaluate')).toBe(true);
  });

  it('does nothing when snapshot was never granted', () => {
    const caps = withBrowserExploreHelpers(new Set<CapabilityId>(['browser.session.open']));
    expect(caps.has('browser.wait')).toBe(false);
    expect(caps.has('browser.evaluate')).toBe(false);
  });
});
