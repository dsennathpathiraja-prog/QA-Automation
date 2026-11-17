import Fastify, { type FastifyInstance } from 'fastify';
import type { DeploymentProfile } from '@qa/domain';
import type { WorkerLoop } from './loop';

export interface WorkerAppDeps {
  loop: WorkerLoop;
  profile: DeploymentProfile;
  readiness?: Record<string, () => Promise<boolean>>;
  stallAfterMs?: number;
}

/** Health endpoints only. The worker takes no commands over HTTP. */
export function buildWorkerApp(deps: WorkerAppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/healthz', async (_req, reply) => {
    const alive = deps.loop.isAlive(deps.stallAfterMs ?? 5 * 60_000);
    const s = deps.loop.snapshot();
    const body = { status: alive ? 'ok' : 'unhealthy', profile: deps.profile, loop: s.state, ticks: s.ticks, errors: s.errors };
    return reply.code(alive ? 200 : 503).send(body);
  });

  app.get('/readyz', async (_req, reply) => {
    const results = await Promise.all(Object.entries(deps.readiness ?? {}).map(async ([k, f]) => [k, await f().catch(() => false)] as const));
    const failing = results.filter(([, ok]) => !ok).map(([k]) => k);
    if (failing.length > 0) return reply.code(503).send({ status: 'degraded', failing });
    return { status: 'ok' };
  });

  return app;
}
