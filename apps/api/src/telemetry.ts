import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SpanStatusCode, counter, histogram, setSpanAttributes, startSpan, type Span } from '@qa/telemetry';

const REQUESTS = counter('qa.http.requests', 'API requests by route, method and status class');
const DURATION = histogram('qa.http.duration', 'API request duration');
const spans = new WeakMap<FastifyRequest, { span: Span; t0: number }>();

/**
 * One span per request, named by method and route pattern (never the concrete URL, which can carry ids
 * or tokens). No headers, query strings, bodies or user identifiers are recorded.
 */
export function registerRequestTelemetry(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    spans.set(req, { span: startSpan(`${req.method} http`, { 'http.request.method': req.method }), t0: Date.now() });
  });
  app.addHook('onResponse', async (req, reply) => {
    const rec = spans.get(req);
    if (!rec) return;
    spans.delete(req);
    const route = req.routeOptions?.url ?? 'unmatched';
    const status = reply.statusCode;
    rec.span.updateName(`${req.method} ${route}`);
    setSpanAttributes(rec.span, { 'http.route': route, 'http.response.status_code': status });
    if (status >= 500) rec.span.setStatus({ code: SpanStatusCode.ERROR });
    rec.span.end();
    const attrs = { method: req.method, route, status_class: `${Math.floor(status / 100)}xx` };
    REQUESTS.add(1, attrs);
    DURATION.record(Date.now() - rec.t0, attrs);
  });
}
