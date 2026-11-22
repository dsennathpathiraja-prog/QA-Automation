import { afterEach, describe, expect, it } from 'vitest';
import {
  bindStorySurface,
  buildNeedsSurfacePlaywrightSource,
  isNeedsSurfaceCase,
  NEEDS_SURFACE_MARKER,
  resolveConfiguredTemplatePreviewUrl,
} from '../src/surface-binding';

const story2357 = [
  '2357',
  'Order Amount Placement in Escrow Notification Template',
  'Email subject: Your amount has been held in escrow.',
  'Greeting: Hi [Customer Name],',
  'CTA: Confirm Delivery',
].join('\n');

afterEach(() => {
  delete process.env.QA_TEMPLATE_PREVIEW_URL;
});

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

  it('binds configured template preview URL as primary when WI has no absolute URL', () => {
    const binding = bindStorySurface({
      story: story2357,
      environmentUrl: 'http://sdk.paynsure.internal/shop',
      templatePreviewUrl: 'http://email-preview-fixture/',
    });
    expect(binding.surfaceKind).toBe('template');
    expect(binding.templatePreviewUrl).toBe('http://email-preview-fixture/');
    expect(binding.primarySurfaceUrl).toBe('http://email-preview-fixture/');
    expect(binding.candidateUrls[0]).toBe('http://email-preview-fixture/');
  });

  it('reads QA_TEMPLATE_PREVIEW_URL when environment setting is unset', () => {
    process.env.QA_TEMPLATE_PREVIEW_URL = 'http://email-preview-fixture/';
    expect(resolveConfiguredTemplatePreviewUrl()).toBe('http://email-preview-fixture/');
    const binding = bindStorySurface({
      story: story2357,
      environmentUrl: 'http://sdk.paynsure.internal/shop',
    });
    expect(binding.primarySurfaceUrl).toBe('http://email-preview-fixture/');
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
