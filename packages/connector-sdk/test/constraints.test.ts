import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { defaultConstraintEvaluators } from '../src/constraints';
import type { CapabilityDescriptor, ExecutionPolicy, ResolvedInstance } from '../src/types';

const descriptor = { id: 'browser.navigate', constraints: ['browser.origin-allowlist'] } as CapabilityDescriptor;
const instance = { id: 'b1', category: 'browser-automation' } as ResolvedInstance;

const run = (url: string, policy: ExecutionPolicy | undefined) => {
  defaultConstraintEvaluators['browser.origin-allowlist']({ descriptor, input: { url }, instance, policy });
};

describe('browser.origin-allowlist', () => {
  it('denies when the run has no allowed origins', () => {
    expect(() => run('https://sdk.paynsure.internal/', { capabilityDeny: [], boundRoles: {}, agentGrants: {} })).toThrow(
      expect.objectContaining({ errorClass: 'denied', message: 'no allowed origins for browser navigation' }),
    );
  });

  it('allows an approved host pattern against a full application URL', () => {
    expect(() =>
      run('https://sdk.paynsure.internal/login', {
        capabilityDeny: [],
        boundRoles: {},
        agentGrants: {},
        allowedOrigins: ['sdk.paynsure.internal'],
      }),
    ).not.toThrow();
  });

  it('allows a full origin entry and rejects an unrelated host', () => {
    const policy: ExecutionPolicy = {
      capabilityDeny: [],
      boundRoles: {},
      agentGrants: {},
      allowedOrigins: ['https://sdk.paynsure.internal'],
    };
    expect(() => run('https://sdk.paynsure.internal/app', policy)).not.toThrow();
    expect(() => run('https://evil.example/', policy)).toThrow(PlatformError);
  });
});
