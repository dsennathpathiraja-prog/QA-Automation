/** Exact host or `*.suffix` (which does not match the bare suffix). */
export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

/**
 * True when the URL is allowed by any allowlist entry.
 * Entries may be full origins/URLs (`https://app.example`) or host patterns
 * (`app.example`, `*.example`) — the same shapes Administrators approve and
 * people type into the Playwright connector field.
 */
export function urlAllowedByAllowlist(url: string | URL, entries: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return false;
  }
  const origin = parsed.origin;
  const host = parsed.hostname;
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.includes('://')) {
      try {
        const allowed = new URL(entry);
        if (allowed.origin.toLowerCase() === origin.toLowerCase()) return true;
        if (matchHost(allowed.hostname, host)) return true;
      } catch {
        /* ignore a malformed allowlist entry */
      }
      continue;
    }
    if (matchHost(entry, host)) return true;
  }
  return false;
}
