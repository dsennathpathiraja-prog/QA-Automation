import { describe, expect, it } from 'vitest';
import {
  bindStorySurface,
  buildNeedsSurfacePlaywrightSource,
  isNeedsSurfaceCase,
  NEEDS_SURFACE_MARKER,
} from '../src/surface-binding';

const story2357 = [
  '2357',
  'Order Amount Placement in Escrow Notification Template',
  'Email subject: Your amount has been held in escrow.',
  'Greeting: Hi [Customer Name],',
  'CTA: Confirm Delivery',
].join('\n');

describe('surface binding', () => {
  it('derives template kind and candidate routes beyond shop root', () => {
    const binding = bindStorySurface({
      story: story2357,
      workItemTitle: 'Order Amount Placement in Escrow Notification Template',
      application: 'PayNSure',
      environmentUrl: 'http://sdk.paynsure.internal/shop',
    });
    expect(binding.surfaceKind).toBe('template');
    expect(binding.candidateRoutes).toContain('/email');
    expect(binding.candidateRoutes).toContain('/preview');
    expect(binding.candidateUrls.some((u) => u.includes('/email'))).toBe(true);
    expect(binding.primarySurfaceUrl).toBeUndefined();
  });

  it('binds primarySurfaceUrl from an absolute WI URL when present', () => {
    const binding = bindStorySurface({
      story: `${story2357}\nPreview: https://sdk.paynsure.internal/email-preview/escrow`,
      environmentUrl: 'http://sdk.paynsure.internal/shop',
    });
    expect(binding.primarySurfaceUrl).toBe('https://sdk.paynsure.internal/email-preview/escrow');
  });

  it('detects needs-surface markers for execute-time Blocked', () => {
    const source = buildNeedsSurfacePlaywrightSource({
      name: 'Positive: Paid Amount',
      gapMessage: 'Only shop was reachable',
      surfaceKind: 'template',
    });
    expect(source).toContain(NEEDS_SURFACE_MARKER);
    expect(source).toMatch(/test\.skip/);
    expect(isNeedsSurfaceCase({ steps: source })).toBe(true);
    expect(isNeedsSurfaceCase({ summary: '[needs-surface] Blocked — explore surface gap' })).toBe(true);
  });
});
