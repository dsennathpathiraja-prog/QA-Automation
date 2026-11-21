import { describe, expect, it } from 'vitest';
import { matchHost, urlAllowedByAllowlist } from '../src/hosts';

describe('matchHost', () => {
  it('matches exact hosts case-insensitively', () => {
    expect(matchHost('sdk.paynsure.internal', 'SDK.paynsure.internal')).toBe(true);
    expect(matchHost('sdk.paynsure.internal', 'other.paynsure.internal')).toBe(false);
  });

  it('matches *.suffix without matching the bare suffix', () => {
    expect(matchHost('*.paynsure.internal', 'sdk.paynsure.internal')).toBe(true);
    expect(matchHost('*.paynsure.internal', 'paynsure.internal')).toBe(false);
  });
});

describe('urlAllowedByAllowlist', () => {
  it('accepts an approved host pattern against a full application URL', () => {
    expect(urlAllowedByAllowlist('https://sdk.paynsure.internal/app', ['sdk.paynsure.internal'])).toBe(true);
    expect(urlAllowedByAllowlist('http://sdk.paynsure.internal/', ['sdk.paynsure.internal'])).toBe(true);
  });

  it('accepts a full origin entry', () => {
    expect(urlAllowedByAllowlist('https://sdk.paynsure.internal/x', ['https://sdk.paynsure.internal'])).toBe(true);
    expect(urlAllowedByAllowlist('https://sdk.paynsure.internal/x', ['https://other.example'])).toBe(false);
  });

  it('rejects when the allowlist is empty or unrelated', () => {
    expect(urlAllowedByAllowlist('https://sdk.paynsure.internal/', [])).toBe(false);
    expect(urlAllowedByAllowlist('https://sdk.paynsure.internal/', ['evil.example'])).toBe(false);
  });
});
