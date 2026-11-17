import { SpanStatusCode, metrics, trace, type Attributes, type Counter, type Histogram, type Span } from '@opentelemetry/api';

export const INSTRUMENTATION_NAME = 'qa-platform';

const SECRET_KEY = /(secret|token|password|authorization|cookie|api[_-]?key|credential)/i;
const MAX_VALUE = 200;

/**
 * Attributes describe what happened, never the data involved. Keys that look like credentials are
 * dropped and long strings are cut, so a careless caller cannot export a payload.
 */
export function safeAttributes(input: Record<string, string | number | boolean | undefined>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || SECRET_KEY.test(k)) continue;
    out[k] = typeof v === 'string' && v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}...` : v;
  }
  return out;
}

const errorClassOf = (e: unknown): string => {
  const c = (e as { errorClass?: unknown } | null)?.errorClass;
  return typeof c === 'string' ? c : 'unknown';
};

/** Runs `fn` inside a span. Failures are marked by error class only; messages can contain data and are never exported. */
export function withSpan<T>(name: string, attributes: Record<string, string | number | boolean | undefined>, fn: (span: Span) => Promise<T>): Promise<T> {
  return trace.getTracer(INSTRUMENTATION_NAME).startActiveSpan(name, { attributes: safeAttributes(attributes) }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      const cls = errorClassOf(e);
      span.setAttribute('error.class', cls);
      span.setStatus({ code: SpanStatusCode.ERROR, message: cls });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** For callers that cannot wrap work in a function (for example framework request hooks). The caller must end the span. */
export function startSpan(name: string, attributes: Record<string, string | number | boolean | undefined>): Span {
  return trace.getTracer(INSTRUMENTATION_NAME).startSpan(name, { attributes: safeAttributes(attributes) });
}

export function setSpanAttributes(span: Span, attributes: Record<string, string | number | boolean | undefined>): void {
  span.setAttributes(safeAttributes(attributes));
}

export function counter(name: string, description: string): Counter {
  return metrics.getMeter(INSTRUMENTATION_NAME).createCounter(name, { description });
}

export function histogram(name: string, description: string, unit = 'ms'): Histogram {
  return metrics.getMeter(INSTRUMENTATION_NAME).createHistogram(name, { description, unit });
}

export { SpanStatusCode };
export type { Attributes, Span };
