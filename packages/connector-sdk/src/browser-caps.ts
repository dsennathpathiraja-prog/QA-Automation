import type { CapabilityId } from './types';

/**
 * Explore UI helpers added in QA-37 (`browser.wait`, `browser.evaluate`).
 * Older Playwright connector probes may predate those rows; if snapshot is
 * already granted, treat the helpers as available so Explore does not silently
 * skip the DOM probe after an upgrade.
 */
export const BROWSER_EXPLORE_HELPER_CAPS = ['browser.wait', 'browser.evaluate'] as const satisfies readonly CapabilityId[];

/** Mutates/returns the set: grant wait+evaluate when snapshot is already permitted. */
export function withBrowserExploreHelpers(caps: Set<CapabilityId>): Set<CapabilityId> {
  if (caps.has('browser.snapshot')) {
    for (const id of BROWSER_EXPLORE_HELPER_CAPS) caps.add(id);
  }
  return caps;
}
