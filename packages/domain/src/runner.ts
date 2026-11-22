import { PlatformError } from './errors';

/**
 * Test runners are short-lived, isolated containers (or Kubernetes Jobs). The worker never gets a
 * container socket: it asks a RunnerLauncher, and the launcher enforces the limits below.
 * The spec has no field for privileged mode, host mounts, host networking or extra capabilities,
 * so none of those can be requested.
 */
export interface RunnerLimits {
  cpus: number;
  memoryMb: number;
  /** Hard wall-clock limit; the launcher kills the runner when it is exceeded. */
  timeoutSeconds: number;
  pids: number;
}

export interface RunnerSpec {
  /** Unique per attempt; also the idempotency key for `launch`. */
  runId: string;
  executionId: string;
  /** Must be pinned by digest, for example `registry.local/playwright@sha256:...`. */
  image: string;
  /** Reference to the signed bundle of selected test assets in the object store. */
  bundleRef: string;
  environmentId: string;
  limits: RunnerLimits;
  /** Hosts the runner may reach (the application under test). Everything else is blocked. */
  allowedHosts: string[];
  /** Reference to short-lived auth material the launcher resolves itself. Never the value. */
  authMaterialRef?: string;
  /** Plain, non-secret settings only. */
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * Small text files the launcher writes under `/tmp` before start (tmpfs). Used for large case lists
   * that cannot fit in env (Docker/env caps). Paths must be `/tmp/<name>` only — no host mounts.
   */
  inlineFiles?: Array<{ path: string; content: string }>;
}

/** Max total UTF-8 bytes for work-item case payloads (chunked across env parts). */
export const RUNNER_INLINE_FILES_MAX_BYTES = 2 * 1024 * 1024;
/** Stay under validateRunnerSpec's 4096-byte per-env cap (and Docker's practical limits). */
export const RUNNER_ENV_CHUNK_SIZE = 4000;
/** Safety valve for enormous case lists after compacting. */
export const RUNNER_ENV_CHUNK_MAX_PARTS = 256;
const INLINE_TMP_PATH = /^\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Split a large string into env vars `PREFIX_PARTS` + `PREFIX_P0`… that each stay under the per-value cap.
 * Used for work-item cases: Docker put-archive into /tmp fails with ReadonlyRootfs (400) before start.
 */
export function chunkEnvValue(prefix: string, value: string, chunkSize = RUNNER_ENV_CHUNK_SIZE): Record<string, string> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) throw new Error('chunkEnvValue prefix must be an uppercase env name stem');
  if (value.length === 0) return { [`${prefix}_PARTS`]: '0' };
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += chunkSize) parts.push(value.slice(i, i + chunkSize));
  if (parts.length > RUNNER_ENV_CHUNK_MAX_PARTS) {
    throw new PlatformError(
      'validation',
      `Payload needs ${parts.length} env chunks but the limit is ${RUNNER_ENV_CHUNK_MAX_PARTS}. Split the work item or shorten case names.`,
    );
  }
  const env: Record<string, string> = { [`${prefix}_PARTS`]: String(parts.length) };
  parts.forEach((part, i) => {
    env[`${prefix}_P${i}`] = part;
  });
  return env;
}

/** Reassemble values produced by chunkEnvValue (runner / tests). */
export function joinEnvChunks(env: Record<string, string | undefined>, prefix: string): string | undefined {
  const n = Number(env[`${prefix}_PARTS`] ?? '');
  if (!Number.isInteger(n) || n < 0) return undefined;
  if (n === 0) return '';
  let out = '';
  for (let i = 0; i < n; i += 1) {
    const part = env[`${prefix}_P${i}`];
    if (part === undefined) return undefined;
    out += part;
  }
  return out;
}

export type RunnerState = 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'unknown';

export interface RunnerHandle {
  id: string;
  runId: string;
  startedAt: Date;
}

export interface RunnerStatus {
  id: string;
  runId: string;
  state: RunnerState;
  exitCode?: number;
  finishedAt?: Date;
  reason?: string;
}

export interface RunnerLauncher {
  /** Idempotent on `spec.runId`: a second launch with the same runId returns the existing handle. */
  launch(spec: RunnerSpec, opts?: { signal?: AbortSignal }): Promise<RunnerHandle>;
  status(runnerId: string): Promise<RunnerStatus>;
  stop(runnerId: string, reason: string): Promise<void>;
  /** Finds runners by label, for the reaper that cleans up after a crashed worker. */
  list(labels: Record<string, string>): Promise<RunnerStatus[]>;
}

export const RUNNER_MAX = { cpus: 8, memoryMb: 16_384, timeoutSeconds: 4 * 3600, pids: 4096 } as const;

const DIGEST_PINNED = /^[a-z0-9][a-z0-9._\-/:]*@sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
const SECRET_LIKE_ENV = /(secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)/i;
const RESERVED_LABEL_PREFIX = 'qa.platform/';

export function validateRunnerSpec(spec: RunnerSpec): string[] {
  const p: string[] = [];
  for (const [name, v] of [['runId', spec.runId], ['executionId', spec.executionId], ['environmentId', spec.environmentId]] as const) {
    if (!ID.test(v)) p.push(`${name} must be 1-128 characters of letters, digits, dot, underscore or dash`);
  }
  if (!DIGEST_PINNED.test(spec.image)) p.push('image must be pinned by digest (name@sha256:<64 hex>); tags such as :latest are not allowed');
  if (!spec.bundleRef) p.push('bundleRef is required');
  const { cpus, memoryMb, timeoutSeconds, pids } = spec.limits;
  if (!(cpus > 0 && cpus <= RUNNER_MAX.cpus)) p.push(`limits.cpus must be above 0 and at most ${RUNNER_MAX.cpus}`);
  if (!(Number.isInteger(memoryMb) && memoryMb >= 128 && memoryMb <= RUNNER_MAX.memoryMb)) p.push(`limits.memoryMb must be a whole number from 128 to ${RUNNER_MAX.memoryMb}`);
  if (!(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= RUNNER_MAX.timeoutSeconds)) p.push(`limits.timeoutSeconds must be a whole number from 1 to ${RUNNER_MAX.timeoutSeconds}`);
  if (!(Number.isInteger(pids) && pids >= 16 && pids <= RUNNER_MAX.pids)) p.push(`limits.pids must be a whole number from 16 to ${RUNNER_MAX.pids}`);
  if (spec.allowedHosts.length === 0) p.push('allowedHosts must list at least one host; runners have no other network access');
  for (const h of spec.allowedHosts) {
    if (h === '*' || h.includes('/') || !HOST.test(h)) p.push(`allowedHosts entry "${h}" is not a host name (wildcards are only allowed as a leading "*.")`);
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (SECRET_LIKE_ENV.test(k)) p.push(`env ${k} looks like a secret; pass credentials through authMaterialRef`);
    if (v.length > 4096) p.push(`env ${k} is too long`);
  }
  for (const k of Object.keys(spec.labels ?? {})) {
    if (k.startsWith(RESERVED_LABEL_PREFIX)) p.push(`label ${k} uses the reserved prefix ${RESERVED_LABEL_PREFIX}`);
  }
  const files = spec.inlineFiles ?? [];
  if (files.length > 8) p.push('inlineFiles may list at most 8 files');
  let inlineBytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      p.push('inlineFiles entries need path and content strings');
      continue;
    }
    if (!INLINE_TMP_PATH.test(file.path)) p.push(`inlineFiles path "${file.path}" must be /tmp/<safe-name>`);
    if (seen.has(file.path)) p.push(`inlineFiles path "${file.path}" is duplicated`);
    seen.add(file.path);
    inlineBytes += Buffer.byteLength(file.content, 'utf8');
  }
  if (inlineBytes > RUNNER_INLINE_FILES_MAX_BYTES) {
    p.push(`inlineFiles total ${inlineBytes} bytes exceeds the ${RUNNER_INLINE_FILES_MAX_BYTES} byte limit; split the work item or shorten case payloads`);
  }
  return p;
}

export function assertValidRunnerSpec(spec: RunnerSpec): void {
  const problems = validateRunnerSpec(spec);
  if (problems.length > 0) throw new PlatformError('validation', `Invalid runner spec: ${problems.join('; ')}`, { problems });
}
