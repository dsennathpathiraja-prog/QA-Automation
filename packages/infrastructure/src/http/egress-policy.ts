import { BlockList, isIP } from 'node:net';
import { PlatformError, type DeploymentProfile, type PlatformEnv } from '@qa/domain';

export interface EgressRule {
  /** Exact host or `*.suffix`. */
  hostPattern: string;
  purpose: 'connector' | 'application' | 'registry' | 'llm' | 'telemetry';
  /** Internal hosts may resolve to private ranges. Required for on-prem Jira/Squash etc. */
  internal: boolean;
  allowHttp?: boolean;
  /** Dev/test only (e.g. local fixtures); ignored in production. */
  allowLoopback?: boolean;
}

const alwaysBlocked = new BlockList();
alwaysBlocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local incl. cloud metadata
alwaysBlocked.addSubnet('0.0.0.0', 8, 'ipv4');
alwaysBlocked.addSubnet('224.0.0.0', 4, 'ipv4');
alwaysBlocked.addSubnet('fe80::', 10, 'ipv6');
alwaysBlocked.addAddress('::', 'ipv6');

const privateRanges = new BlockList();
privateRanges.addSubnet('10.0.0.0', 8, 'ipv4');
privateRanges.addSubnet('172.16.0.0', 12, 'ipv4');
privateRanges.addSubnet('192.168.0.0', 16, 'ipv4');
privateRanges.addSubnet('100.64.0.0', 10, 'ipv4');
privateRanges.addSubnet('fc00::', 7, 'ipv6');

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

export interface EgressPolicyOptions {
  rules: readonly EgressRule[];
  profile: DeploymentProfile;
  platformEnv: PlatformEnv;
}

/** Deny-by-default. The same list drives the egress proxy allowlist; this is the in-process second line. */
export class EgressPolicy {
  constructor(private readonly o: EgressPolicyOptions) {}

  assertAllowed(url: URL): EgressRule {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const rule = this.o.rules.find((r) => matchHost(r.hostPattern, host));
    if (!rule) throw new PlatformError('denied', `host ${host} is not on the approved-host list`);
    if (this.o.profile === 'airgapped' && !rule.internal) {
      throw new PlatformError('denied', `host ${host} is external and the air-gapped profile forbids external egress`);
    }
    if (url.protocol === 'http:') {
      if (!(rule.internal && rule.allowHttp)) throw new PlatformError('denied', `plain http is not allowed for ${host}`);
    } else if (url.protocol !== 'https:') {
      throw new PlatformError('denied', `protocol ${url.protocol} is not allowed`);
    }
    if (isIP(host)) this.assertIps([host], rule);
    return rule;
  }

  assertIps(ips: readonly string[], rule: EgressRule): void {
    for (const ip of ips) {
      const f = family(ip);
      if (alwaysBlocked.check(ip, f)) throw new PlatformError('denied', `address ${ip} is in a blocked range`);
      if (loopback.check(ip, f) && !(rule.allowLoopback && this.o.platformEnv !== 'production')) {
        throw new PlatformError('denied', `address ${ip} is loopback`);
      }
      if (privateRanges.check(ip, f) && !rule.internal) {
        throw new PlatformError('denied', `address ${ip} is private but host is not approved as internal`);
      }
    }
  }
}
