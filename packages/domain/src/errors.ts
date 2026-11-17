export type ErrorClass =
  | 'transient'
  | 'rate-limited'
  | 'auth'
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'denied'
  | 'unsupported'
  | 'cancelled'
  | 'internal';

const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['transient', 'rate-limited']);

export class PlatformError extends Error {
  readonly errorClass: ErrorClass;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(errorClass: ErrorClass, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PlatformError';
    this.errorClass = errorClass;
    this.retryable = RETRYABLE.has(errorClass);
    this.details = details;
  }
}

export const isPlatformError = (e: unknown): e is PlatformError => e instanceof PlatformError;
