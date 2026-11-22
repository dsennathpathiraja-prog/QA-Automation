/**
 * Story-first analysis + scenario themes from work item title / description / AC.
 * Authoritative when UI/code explore are weak or mismatched (e.g. WI 2357).
 */

import type { ScenarioKind } from './types';

export interface StoryScenarioSeed {
  kind: ScenarioKind;
  label: string;
  criterion: string;
  steps: string;
  expected: string;
}

export interface StoryAnalysis {
  workItemTitle: string;
  /** SCM / UI search terms derived from the story — never product name alone. */
  searchTerms: string[];
  /** Likely UI surfaces (email template, preview, shop order trigger, …). */
  surfaces: string[];
  /** Send / lifecycle triggers. */
  triggers: string[];
  /** Dynamic placeholders that must not remain hardcoded brackets. */
  placeholders: string[];
  /** True when this is an escrow/notification email template WI. */
  notificationTemplate: boolean;
}

const clip = (value: string, max: number) => value.trim().slice(0, max);

const STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'as', 'by',
  'from', 'that', 'this', 'it', 'user', 'should', 'must', 'can', 'will', 'when', 'then', 'given',
  'acceptance', 'criteria', 'description', 'notes', 'verify', 'work', 'item', 'title',
]);

const normalize = (w: string) => w.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

/** Detect escrow / notification email template work items from story + criteria. */
export function isNotificationTemplateStory(story: string, criteria: string[] = []): boolean {
  const blob = [story, ...criteria].join('\n');
  return /escrow|notification.?template|email.?template|confirm delivery|paid amount|held in escrow/i.test(blob);
}

/**
 * Analyze the work item for explore queries and scenario identity.
 * Does not use application/product name alone.
 */
export function analyzeWorkItemStory(input: {
  story: string;
  criteria?: string[];
  workItemTitle?: string;
  application?: string;
}): StoryAnalysis {
  const criteria = input.criteria ?? [];
  const title = (input.workItemTitle || '').trim();
  const blob = [title, input.story, ...criteria].join('\n');
  const product = new Set(
    (input.application || '').toLowerCase().split(/[^a-z0-9]+/).map(normalize).filter((t) => t.length >= 3),
  );

  const phrases: string[] = [];
  for (const re of [
    /held in escrow/i,
    /confirm delivery/i,
    /paid amount/i,
    /order amount/i,
    /notification template/i,
    /email subject/i,
    /customer name/i,
    /order details/i,
    /payment status/i,
  ]) {
    const m = blob.match(re);
    if (m) phrases.push(m[0].toLowerCase());
  }

  const tokens = blob
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\s]+/g, ' ')
    .split(/\s+/)
    .map(normalize)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !product.has(w));

  const preferred = [
    'escrow', 'notification', 'template', 'email', 'subject', 'greeting', 'merchant',
    'amount', 'paid', 'order', 'delivery', 'confirm', 'placeholder', 'completed', 'placed',
  ];
  const ranked = [
    ...phrases,
    ...preferred.filter((p) => tokens.includes(p) || blob.toLowerCase().includes(p)),
    ...tokens,
  ];
  const searchTerms = [...new Set(ranked)].slice(0, 12);

  const surfaces: string[] = [];
  if (isNotificationTemplateStory(blob, criteria)) {
    surfaces.push('escrow notification email template');
    surfaces.push('email preview / template editor (if available)');
  }
  if (/confirm delivery/i.test(blob)) surfaces.push('Confirm Delivery CTA / secure PayNSure page');
  if (/shop|checkout|cart|order summary/i.test(blob)) surfaces.push('checkout / order placement (trigger only)');

  const triggers: string[] = [];
  if (/completed/i.test(blob)) triggers.push('Payment Status COMPLETED');
  if (/placed/i.test(blob)) triggers.push('order Placed');
  if (/checkout|payment auth/i.test(blob)) triggers.push('checkout + payment authorization');

  const placeholders = [...blob.matchAll(/\[([A-Za-z][A-Za-z0-9 ]{1,40})\]/g)]
    .map((m) => `[${m[1]!.trim()}]`)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .slice(0, 12);
  if (placeholders.length === 0 && /customer name|order id|merchant|paid amount/i.test(blob)) {
    placeholders.push('[Customer Name]', '[Order ID]', '[Merchant]', '[Paid Amount]');
  }

  return {
    workItemTitle: title,
    searchTerms,
    surfaces: [...new Set(surfaces)],
    triggers: [...new Set(triggers)],
    placeholders,
    notificationTemplate: isNotificationTemplateStory(blob, criteria),
  };
}

/**
 * Concrete scenario themes for notification/escrow email templates (WI 2357-style).
 * Prioritize these over shop-catalog explore when the template surface was not reached.
 */
export function notificationTemplateScenarioSeeds(input: {
  story: string;
  criteria?: string[];
  workItemTitle?: string;
}): StoryScenarioSeed[] {
  const criteria = input.criteria ?? [];
  const analysis = analyzeWorkItemStory(input);
  if (!analysis.notificationTemplate) return [];

  const title = analysis.workItemTitle || 'Escrow notification template';
  const seeds: StoryScenarioSeed[] = [];
  const push = (seed: StoryScenarioSeed) => {
    seeds.push({
      ...seed,
      criterion: clip(seed.criterion, 160),
      steps: clip(seed.steps, 500),
      expected: clip(seed.expected, 300),
    });
  };

  push({
    kind: 'positive',
    label: 'email subject states amount held in escrow',
    criterion: 'Email subject: Your amount has been held in escrow.',
    steps: `Open the escrow notification for ${title}. Read the email subject line. Confirm it equals "Your amount has been held in escrow."`,
    expected: 'Subject is exactly the escrow hold wording from the work item.',
  });

  push({
    kind: 'positive',
    label: 'greeting includes dynamic customer name',
    criterion: 'Greeting: Hi [Customer Name],',
    steps: 'Open the notification. Confirm greeting starts with "Hi " followed by the live customer name from data — not the literal bracket token [Customer Name].',
    expected: 'Greeting shows a real customer name; brackets are resolved.',
  });

  push({
    kind: 'negative',
    label: 'reject literal [Customer Name] bracket in greeting',
    criterion: 'Greeting: Hi [Customer Name],',
    steps: 'Render the notification with missing customer name. Confirm the body does not ship the hardcoded bracket placeholder to the recipient.',
    expected: 'Hardcoded [Customer Name] is not shown; send is blocked or a safe fallback is used.',
  });

  push({
    kind: 'positive',
    label: 'main escrow message includes Order ID and Merchant',
    criterion: 'Main message: order #[Order ID] from [Merchant], payment held in escrow until confirm delivery',
    steps: 'Open the main message. Confirm it references the live Order ID and Merchant and states payment is held in escrow until the shopper confirms delivery.',
    expected: 'Main message shows resolved Order ID and Merchant with escrow-until-confirm-delivery wording.',
  });

  push({
    kind: 'positive',
    label: 'Paid Amount placement in order details table',
    criterion: 'Order details table: Order ID, Merchant, Order Date, Paid Amount (dynamic)',
    steps: 'Open the order details summary table. Confirm columns Order ID, Merchant, Order Date, and Paid Amount. Assert Paid Amount is the dynamic paid value from the order — not a hardcoded sample.',
    expected: 'Paid Amount appears in the table with the live order amount.',
  });

  push({
    kind: 'edge',
    label: 'zero and maximum Paid Amount in table',
    criterion: 'Paid Amount (dynamic, not hardcoded)',
    steps: 'Render notifications for a zero paid amount and a maximum currency amount. Confirm both place Paid Amount correctly in the table without hardcoded brackets.',
    expected: 'Boundary amounts still appear in Paid Amount; no [Paid Amount] token remains.',
  });

  push({
    kind: 'positive',
    label: 'CTA Confirm Delivery with secure-page sub-text',
    criterion: 'CTA: Confirm Delivery → secure PayNSure page; sub-text about browser',
    steps: 'Locate the Confirm Delivery call-to-action. Confirm it targets the secure PayNSure page and that browser/security sub-text is present under the CTA.',
    expected: 'Confirm Delivery CTA and supporting browser sub-text are both visible and correct.',
  });

  push({
    kind: 'positive',
    label: 'support footer contact and copyright',
    criterion: 'Closing/support: support@paynsure.com, phone, paynsure.com, © PayNSure Escrow',
    steps: 'Scroll to the closing/support footer. Confirm support@paynsure.com, the support phone, paynsure.com, and the PayNSure Escrow copyright line.',
    expected: 'Support footer shows email, phone, site, and copyright from the work item.',
  });

  push({
    kind: 'positive',
    label: 'send when payment COMPLETED and order Placed',
    criterion: 'Trigger: Payment Status COMPLETED; email when order Placed',
    steps: 'Complete checkout with payment authorization so Payment Status is COMPLETED and the order is Placed. Confirm the escrow notification is sent once for that transition.',
    expected: 'Notification send fires on COMPLETED + Placed; not before payment completes.',
  });

  push({
    kind: 'negative',
    label: 'do not send before COMPLETED / Placed',
    criterion: 'Trigger: checkout + payment auth; email when order Placed',
    steps: 'Leave payment incomplete or order not Placed. Confirm the escrow notification email is not sent.',
    expected: 'No escrow notification is delivered before COMPLETED and Placed.',
  });

  push({
    kind: 'edge',
    label: 'no hardcoded bracket placeholders in rendered email',
    criterion: 'Placeholders [...] from real-time DB',
    steps: `Render a full notification with live DB values. Scan for unresolved tokens: ${analysis.placeholders.join(', ') || '[Order ID], [Merchant], [Customer Name], [Paid Amount]'}.`,
    expected: 'No unresolved bracket placeholders remain in the rendered email.',
  });

  return seeds;
}
