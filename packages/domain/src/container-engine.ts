import { PlatformError } from './errors';
import { assertValidRunnerSpec, type RunnerSpec } from './runner';

export const LABEL = {
  runId: 'qa.platform/run-id',
  executionId: 'qa.platform/execution-id',
  timeoutSeconds: 'qa.platform/timeout-seconds',
  managed: 'qa.platform/managed',
} as const;

export interface ContainerState {
  id: string;
  name: string;
  status: 'created' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'removing' | 'unknown';
  exitCode?: number;
  startedAt?: Date;
  finishedAt?: Date;
  oomKilled?: boolean;
  labels: Record<string, string>;
}

/** The few container operations the launcher needs. The real implementation talks to the Docker Engine API. */
export interface ContainerEngine {
  /** Creates a container; throws PlatformError('conflict') when the name is taken. */
  create(name: string, body: Record<string, unknown>): Promise<{ id: string }>;
  start(id: string): Promise<void>;
  inspect(idOrName: string): Promise<ContainerState | undefined>;
  stop(id: string, graceSeconds: number): Promise<void>;
  list(labels: Record<string, string>): Promise<ContainerState[]>;
  /** The local image id (`sha256:...`), or undefined when the engine has no such image. */
  inspectImage(ref: string): Promise<{ id: string } | undefined>;
  /** The runner's own stdout and stderr, as text. */
  logs(id: string): Promise<string>;
  /**
   * Writes text files into the container before start (Docker archive API). Paths are absolute inside
   * the container; the launcher only allows `/tmp/...` via RunnerSpec validation.
   */
  putFiles?(id: string, files: Array<{ path: string; content: string }>): Promise<void>;
}

export interface TranslateOptions {
  /** Internal network with no route out except through the egress proxy. */
  network: string;
  /** Egress proxy URL given to the runner as HTTP(S)_PROXY. */
  proxyUrl?: string;
  /** Unprivileged user inside the container. */
  user?: string;
}

export const containerName = (runId: string) => `qa-runner-${runId}`;

/**
 * Turns a validated RunnerSpec into a Docker create request. Every runner gets the same hardening, and
 * the request has no way to ask for less: no privileged mode, no mounts, no host namespaces, all
 * capabilities dropped, read-only root filesystem, bounded memory, CPU and processes.
 */
export function toDockerCreateBody(spec: RunnerSpec, o: TranslateOptions): Record<string, unknown> {
  assertValidRunnerSpec(spec);
  const memory = spec.limits.memoryMb * 1024 * 1024;
  const env = {
    ...spec.env,
    QA_RUN_ID: spec.runId,
    QA_EXECUTION_ID: spec.executionId,
    QA_BUNDLE_REF: spec.bundleRef,
    QA_ENVIRONMENT_ID: spec.environmentId,
    QA_ALLOWED_HOSTS: spec.allowedHosts.join(','),
    ...(spec.authMaterialRef ? { QA_AUTH_MATERIAL_REF: spec.authMaterialRef } : {}),
    ...(o.proxyUrl ? { HTTP_PROXY: o.proxyUrl, HTTPS_PROXY: o.proxyUrl, http_proxy: o.proxyUrl, https_proxy: o.proxyUrl } : {}),
  };
  return {
    Image: spec.image,
    User: o.user ?? '1000:1000',
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: {
      ...spec.labels,
      [LABEL.managed]: 'true',
      [LABEL.runId]: spec.runId,
      [LABEL.executionId]: spec.executionId,
      [LABEL.timeoutSeconds]: String(spec.limits.timeoutSeconds),
    },
    StopTimeout: 10,
    HostConfig: {
      NetworkMode: o.network,
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(spec.limits.cpus * 1e9),
      PidsLimit: spec.limits.pids,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m', '/home/runner': 'rw,noexec,nosuid,size=256m' },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      PublishAllPorts: false,
    },
  };
}

export function stateOf(c: ContainerState): { state: 'starting' | 'running' | 'exited' | 'failed' | 'stopped' | 'unknown'; exitCode?: number; reason?: string } {
  switch (c.status) {
    case 'created':
      return { state: 'starting' };
    case 'running':
    case 'restarting':
    case 'paused':
      return { state: 'running' };
    case 'exited':
      if (c.oomKilled) return { state: 'failed', exitCode: c.exitCode, reason: 'out of memory' };
      return { state: c.exitCode === 0 ? 'exited' : 'failed', exitCode: c.exitCode };
    case 'dead':
      return { state: 'failed', exitCode: c.exitCode };
    default:
      return { state: 'unknown' };
  }
}

/** Stops runners that outlived their own wall-clock limit. Run on a timer by the launcher service. */
export async function enforceTimeouts(engine: ContainerEngine, now: Date): Promise<string[]> {
  const stopped: string[] = [];
  for (const c of await engine.list({ [LABEL.managed]: 'true' })) {
    if (c.status !== 'running' || !c.startedAt) continue;
    const limit = Number(c.labels[LABEL.timeoutSeconds]);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    if (now.getTime() - c.startedAt.getTime() > limit * 1000) {
      await engine.stop(c.id, 10);
      stopped.push(c.labels[LABEL.runId] ?? c.id);
    }
  }
  return stopped;
}

export function requireConflict(e: unknown): boolean {
  return e instanceof PlatformError && e.errorClass === 'conflict';
}
