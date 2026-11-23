import { describe, expect, it } from 'vitest';
import {
  collectCrawlTargets,
  createCrawlBounds,
  crawlBudgetOpen,
  formatExplorePageProgress,
  isDestructiveNavLabel,
  normalizeExploreUrl,
  parseCrawlDiscovery,
  sameExploreHost,
  scoreCrawlTarget,
} from '../src/explore-crawl';

describe('explore-crawl', () => {
  const keywords = {
    terms: ['checkout', 'cart', 'escrow'],
    criteria: ['User can open checkout', 'Paid Amount visible'],
    surfaces: ['checkout order trigger'],
  };

  it('scores story-relevant nav higher than unrelated labels', () => {
    const checkout = scoreCrawlTarget('Checkout', 'https://shop.example/checkout', keywords);
    const random = scoreCrawlTarget('Cookie settings', 'https://shop.example/cookies', keywords);
    expect(checkout).toBeGreaterThan(random);
  });

  it('rejects destructive labels and mailto/hash hrefs', () => {
    expect(isDestructiveNavLabel('Delete account')).toBe(true);
    expect(isDestructiveNavLabel('Pay now')).toBe(true);
    expect(isDestructiveNavLabel('Cart')).toBe(false);
    expect(scoreCrawlTarget('Delete order', 'https://shop.example/x', keywords)).toBeLessThan(0);
    expect(scoreCrawlTarget('Email us', 'mailto:a@b.com', keywords)).toBeLessThan(0);
  });

  it('keeps crawl targets on the same host and skips visited URLs', () => {
    const visited = new Set(['https://shop.example/cart']);
    const targets = collectCrawlTargets({
      links: [
        { label: 'Cart', href: 'https://shop.example/cart' },
        { label: 'Checkout', href: 'https://shop.example/checkout' },
        { label: 'External', href: 'https://other.example/' },
        { label: 'Mail', href: 'mailto:x@y.com' },
      ],
      buttons: ['Delete', 'Proceed to checkout'],
      pageUrl: 'https://shop.example/shop',
      depth: 1,
      keywords,
      visited,
    });
    expect(targets.every((t) => !t.href || sameExploreHost('https://shop.example/shop', t.href))).toBe(true);
    expect(targets.some((t) => /checkout/i.test(t.label))).toBe(true);
    expect(targets.some((t) => /delete/i.test(t.label))).toBe(false);
    expect(targets.some((t) => t.href?.includes('/cart'))).toBe(false);
  });

  it('enforces page and time budgets', () => {
    const bounds = createCrawlBounds({ maxPages: 3, maxMs: 5_000, now: 1_000 });
    expect(crawlBudgetOpen(bounds, 2, 1_500)).toBe(true);
    expect(crawlBudgetOpen(bounds, 3, 1_500)).toBe(false);
    expect(crawlBudgetOpen(bounds, 1, 6_100)).toBe(false);
  });

  it('parses crawl discovery JSON and formats operator progress', () => {
    const parsed = parseCrawlDiscovery(JSON.stringify({
      url: 'https://shop.example/shop',
      links: [{ label: 'Cart', href: '/cart' }, { text: 'Help', href: '/help' }],
      buttons: ['Add to cart'],
    }));
    expect(parsed?.links).toHaveLength(2);
    expect(parsed?.buttons).toEqual(['Add to cart']);
    expect(formatExplorePageProgress([
      'https://shop.example/shop',
      'https://shop.example/cart',
      'https://shop.example/shop',
    ])).toMatch(/Explored 2 pages:/);
    expect(normalizeExploreUrl('https://shop.example/cart/#x')).toBe('https://shop.example/cart');
  });
});
