import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { LABEL, PlatformError, containerName, requireConflict, stateOf, toDockerCreateBody, validateRunnerSpec, type ContainerEngine, type ContainerState, type RunnerSpec, type TranslateOptions } from '@qa/domain';

export interface LauncherDeps {
  engine: ContainerEngine;
  /** Bearer token the worker presents. Rotated by restarting the launcher with a new value. */
  token: string;
  translate: TranslateOptions;
  /** Only images from these registries may run, for example ['registry.local/qa/']. */
  allowedImagePrefixes: string[];
  maxConcurrent: number;
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const err = (cls: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { class: cls, message, ...extra } });

function status(c: ContainerState) {
  const s = stateOf(c);
  return { id: c.id, runId: c.labels[LABEL.runId] ?? '', state: s.state, exitCode: s.exitCode, finishedAt: c.finishedAt?.toISOString(), reason: s.reason };
}

/**
 * The only component allowed to talk to the container engine. It refuses anything that is not a platform
 * runner: containers without the managed label cannot be inspected, stopped or listed through it.
 */
export function buildLauncherApp(deps: LauncherDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !same(auth.slice(7), deps.token)) return reply.code(401).send(err('auth', 'unauthorized'));
  });

  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof PlatformError) {
      const code = e.errorClass === 'not-found' ? 404 : e.errorClass === 'validation' ? 400 : e.errorClass === 'denied' ? 403 : e.errorClass === 'rate-limited' ? 429 : 502;
      return reply.code(code).send(err(e.errorClass, e.message));
    }
    return reply.code(500).send(err('internal', 'internal error'));
  });

  const managed = async (id: string): Promise<ContainerState> => {
    const c = await deps.engine.inspect(id);
    if (!c || c.labels[LABEL.managed] !== 'true') throw new PlatformError('not-found', 'runner not found');
    return c;
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/v1/runners', async (req, reply) => {
    const spec = req.body as RunnerSpec;
    const problems = validateRunnerSpec(spec);
    if (problems.length > 0) return reply.code(400).send(err('validation', 'invalid runner spec', { problems }));
    if (!deps.allowedImagePrefixes.some((p) => spec.image.startsWith(p))) {
      return reply.code(403).send(err('denied', 'image registry is not approved for runners'));
    }
    const name = containerName(spec.runId);
    const existing = await deps.engine.inspect(name);
    if (existing) return reply.code(200).send({ id: existing.id, runId: spec.runId, startedAt: (existing.startedAt ?? new Date()).toISOString() });
    const running = (await deps.engine.list({ [LABEL.managed]: 'true' })).filter((c) => c.status === 'running' || c.status === 'created').length;
    if (running >= deps.maxConcurrent) return reply.code(429).send(err('rate-limited', 'the runner pool is full; try again later'));

    let id: string;
    try {
      id = (await deps.engine.create(name, toDockerCreateBody(spec, deps.translate))).id;
    } catch (e) {
      if (!requireConflict(e)) throw e;
      const c = await deps.engine.inspect(name);
      if (!c) throw e;
      return reply.code(200).send({ id: c.id, runId: spec.runId, startedAt: (c.startedAt ?? new Date()).toISOString() });
    }
    await deps.engine.start(id);
    return reply.code(201).send({ id, runId: spec.runId, startedAt: new Date().toISOString() });
  });

  app.get<{ Params: { id: string } }>('/v1/runners/:id', async (req) => status(await managed(req.params.id)));

  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/v1/runners/:id/stop', async (req, reply) => {
    const c = await managed(req.params.id);
    await deps.engine.stop(c.id, 10);
    return reply.code(200).send({ ok: true });
  });

  app.get<{ Querystring: Record<string, string> }>('/v1/runners', async (req) => {
    const labels: Record<string, string> = { [LABEL.managed]: 'true' };
    for (const [k, v] of Object.entries(req.query)) if (k.startsWith('label.')) labels[k.slice(6)] = String(v);
    return { items: (await deps.engine.list(labels)).map(status) };
  });

  return app;
}
