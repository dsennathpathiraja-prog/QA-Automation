/**
 * Operator-facing copy for runner image / pool failures.
 * Commands are PowerShell-safe (Windows Compose is the usual local path).
 */

export const COMPOSE_LOCAL = 'deploy/compose/local/docker-compose.local.yml';

/** Rebuild / start the local stack so runner-launcher and qa-runner:local exist. */
export const RUNNER_REBUILD_PS = [
  `docker compose -f ${COMPOSE_LOCAL} up --build -d`,
].join('\n');

/** List then force-remove managed runner leftovers (PowerShell). */
export const RUNNER_RECLAIM_PS = [
  'docker ps -a --filter "label=qa.platform/managed=true"',
  'docker ps -aq --filter "label=qa.platform/managed=true" | ForEach-Object { docker rm -f $_ }',
].join('\n');

export const RUNNER_IMAGE_MISSING =
  `The runner image qa-runner:local is not on this machine yet. In PowerShell from the repo root:\n${RUNNER_REBUILD_PS}\nThen re-run.`;

export const RUNNER_LAUNCHER_REQUIRED =
  `Playwright runner-launcher is not available. In PowerShell from the repo root, start the local stack so runner-launcher and qa-runner:local are up:\n${RUNNER_REBUILD_PS}\nThen re-run.`;

export const RUNNER_POOL_STAYED_FULL =
  `The runner pool stayed full after waiting. In PowerShell, reclaim leftover qa-runner containers (plain docker ps hides created/exited orphans), or raise RUNNER_MAX_CONCURRENT and restart runner-launcher, then re-run:\n${RUNNER_RECLAIM_PS}`;

export const RUNNER_CANCELLED = 'This work-item run was cancelled. The runner container was stopped and removed so the pool slot is free.';
