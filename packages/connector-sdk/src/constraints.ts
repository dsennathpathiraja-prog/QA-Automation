import { PlatformError } from '@qa/domain';
import type { CapabilityDescriptor, ConstraintId, ExecutionPolicy, ResolvedInstance } from './types';

export interface ConstraintContext {
  descriptor: CapabilityDescriptor;
  input: Record<string, unknown>;
  instance: ResolvedInstance;
  policy: ExecutionPolicy | undefined;
}

export type ConstraintEvaluator = (ctx: ConstraintContext) => void;

const denied = (msg: string) => new PlatformError('denied', msg);

/** Calls may only touch the project/org/repo/branch configured on the instance. */
const scope: ConstraintEvaluator = ({ input, instance }) => {
  const s = instance.scope;
  const check = (field: 'project' | 'org' | 'repo' | 'branch') => {
    const want = s[field];
    const got = input[field];
    if (want !== undefined && got !== undefined && got !== want) {
      throw denied(`${field} '${String(got)}' is outside the connector scope`);
    }
  };
  check('project');
  check('org');
  check('repo');
  check('branch');
};

/** Navigation is limited to the origins of the selected environment. */
const browserOrigins: ConstraintEvaluator = ({ input, policy }) => {
  if (typeof input.url !== 'string') return;
  const allowed = policy?.allowedOrigins;
  if (!allowed || allowed.length === 0) throw denied('no allowed origins for browser navigation');
  let origin: string;
  try {
    origin = new URL(input.url).origin;
  } catch {
    throw new PlatformError('validation', 'invalid URL');
  }
  if (!allowed.includes(origin)) throw denied(`origin ${origin} is not allowed for this execution`);
};

const sizeMax: ConstraintEvaluator = ({ input }) => {
  const json = JSON.stringify(input);
  if (json.length > 25 * 1024 * 1024) throw denied('request payload exceeds size limit');
};

export const defaultConstraintEvaluators: Record<ConstraintId, ConstraintEvaluator> = {
  scope,
  'browser.origin-allowlist': browserOrigins,
  'size.max': sizeMax,
};
