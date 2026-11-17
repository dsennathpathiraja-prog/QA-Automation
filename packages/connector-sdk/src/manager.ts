import { createHash } from 'node:crypto';
import { counter, histogram, setSpanAttributes, withSpan } from '@qa/telemetry';
import { PlatformError, isPlatformError, type Clock, type SecretLease, type SecretStore, systemClock } from '@qa/domain';
import type { CapabilityRegistry } from './catalog';
import { defaultConstraintEvaluators, type ConstraintEvaluator } from './constraints';
import { evaluateMachinePolicy } from './policy';
import type { ProviderRegistry } from './registry';
import { CircuitBreaker, TokenBucket } from './resilience';
import type {
  AdapterDeps,
  CapabilityDescriptor,
  CapabilityInvoker,
  ConstraintId,
  ExecutionPolicy,
  ExecutionPolicyStore,
  InstanceResolver,
  InvokeRequest,
  OperationLogEntry,
  OperationLogSink,
  Redactor,
  ResolvedInstance,
} from './types';

const INVOKE_COUNT = counter('qa.connector.invocations', 'Connector capability calls by capability and outcome');
const INVOKE_MS = histogram('qa.connector.duration', 'Connector capability call duration');

export interface ConnectorExecutionManagerDeps {
  capabilities: CapabilityRegistry;
  providers: ProviderRegistry;
  instances: InstanceResolver;
  policies: ExecutionPolicyStore;
  secrets: SecretStore;
  log: OperationLogSink;
  redactor: Redactor;
  adapterDeps: AdapterDeps;
  clock?: Clock;
  constraintEvaluators?: Partial<Record<ConstraintId, ConstraintEvaluator>>;
  defaults?: {
    timeoutMs?: number;
    ratePerSec?: number;
    burst?: number;
    breakerThreshold?: number;
    breakerCooldownMs?: number;
  };
}

/**
 * The only runtime path to a connector. Pipeline: resolve -> authorize -> validate -> constrain ->
 * rate-limit/breaker -> lease secret -> handle -> validate output -> redact -> audit.
 * Retries are the engine's responsibility; the manager never retries.
 */
export class ConnectorExecutionManager implements CapabilityInvoker {
  private readonly clock: Clock;
  private readonly evaluators: Record<ConstraintId, ConstraintEvaluator>;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly d: ConnectorExecutionManagerDeps) {
    this.clock = d.clock ?? systemClock;
    this.evaluators = { ...defaultConstraintEvaluators, ...d.constraintEvaluators } as Record<ConstraintId, ConstraintEvaluator>;
  }

  /** Traced and counted; spans carry capability and outcome, never inputs, outputs or credentials. */
  async invoke<O = unknown, I = unknown>(req: InvokeRequest<I>): Promise<O> {
    const t0 = Date.now();
    let outcome = 'ok';
    return withSpan('connector.invoke', { capability: req.capability, 'actor.type': req.actor.type, 'connector.role': req.role }, async (span) => {
      try {
        return await this.invokeInner<O, I>(req);
      } catch (e) {
        outcome = isPlatformError(e) ? e.errorClass : 'internal';
        throw e;
      } finally {
        setSpanAttributes(span, { outcome });
        INVOKE_COUNT.add(1, { capability: req.capability, outcome });
        INVOKE_MS.record(Date.now() - t0, { capability: req.capability, outcome });
      }
    });
  }

  private async invokeInner<O, I>(req: InvokeRequest<I>): Promise<O> {
    const started = this.clock.now().getTime();
    let descriptor: CapabilityDescriptor | undefined;
    let instance: ResolvedInstance | undefined;
    const base = (): Omit<OperationLogEntry, 'outcome' | 'durationMs'> => ({
      at: this.clock.now(),
      executionId: req.actor.executionId,
      stepId: req.actor.stepId,
      actorType: req.actor.type,
      actorId: req.actor.id,
      connectorInstanceId: instance?.id,
      capability: req.capability,
      access: descriptor?.access,
      requestDigest: this.digest(req),
      idempotencyKey: req.idempotencyKey,
    });
    const finish = async (outcome: OperationLogEntry['outcome'], extra: Partial<OperationLogEntry> = {}) => {
      await this.d.log.append({ ...base(), outcome, durationMs: this.clock.now().getTime() - started, ...extra });
    };

    try {
      descriptor = this.d.capabilities.get(req.capability);
      const policy = req.actor.executionId ? await this.d.policies.get(req.actor.executionId) : undefined;
      instance = await this.resolveInstance(req, policy);

      const decision = evaluateMachinePolicy({ req, instance, descriptor, policy, actor: req.actor });
      if (!decision.allow) throw new PlatformError('denied', decision.reason);

      const parsed = descriptor.input.safeParse(req.input);
      if (!parsed.success) throw new PlatformError('validation', `invalid input for ${descriptor.id}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      const input = parsed.data as Record<string, unknown>;

      for (const cid of descriptor.constraints ?? []) {
        this.evaluators[cid]({ descriptor, input, instance, policy });
      }

      this.checkRate(instance.id);
      const breaker = this.breaker(instance.id);
      breaker.assertClosed();

      let lease: SecretLease | undefined;
      try {
        if (instance.secretLocator) {
          lease = await this.d.secrets.lease(instance.secretLocator, { ttlMs: 5 * 60_000 });
          this.d.redactor.register(lease.value);
        }
        const provider = this.d.providers.get(instance.providerKey);
        const client = provider.create(instance.config, lease, this.d.adapterDeps);
        const timeoutMs = this.d.defaults?.timeoutMs ?? 30_000;
        const ac = new AbortController();
        const onAbort = () => ac.abort(req.signal?.reason);
        req.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ac.abort(new PlatformError('transient', `connector call timed out after ${timeoutMs}ms`)), timeoutMs);
        try {
          const raw = await Promise.race([
            client.handle(descriptor, input, { instanceId: instance.id, config: instance.config, scope: instance.scope, signal: ac.signal }),
            new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(ac.signal.reason instanceof Error ? ac.signal.reason : new PlatformError('cancelled', 'cancelled')), { once: true })),
          ]);
          const out = descriptor.output.safeParse(raw);
          if (!out.success) throw new PlatformError('internal', `connector returned invalid output for ${descriptor.id}`);
          breaker.success();
          const redacted = this.d.redactor.redact(out.data) as O;
          await finish('ok');
          return redacted;
        } catch (e) {
          breaker.failure(e);
          throw e;
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
          await client.dispose().catch(() => undefined);
        }
      } finally {
        lease?.release();
      }
    } catch (e) {
      const err = this.normalize(e);
      if (err.errorClass === 'denied') await finish('denied', { denialReason: err.message, errorClass: 'denied' });
      else await finish('error', { errorClass: err.errorClass });
      throw err;
    }
  }

  private async resolveInstance(req: InvokeRequest, policy: ExecutionPolicy | undefined): Promise<ResolvedInstance> {
    let id = req.connectorInstanceId;
    if (req.role) {
      if (!policy) throw new PlatformError('denied', 'role resolution requires an execution policy');
      id = policy.boundRoles[req.role];
      if (!id) throw new PlatformError('denied', `role ${req.role} is not bound for this execution`);
    }
    if (!id) throw new PlatformError('validation', 'role or connectorInstanceId is required');
    const inst = await this.d.instances.getById(id);
    if (!inst) throw new PlatformError('not-found', 'connector instance not found');
    return inst;
  }

  private checkRate(instanceId: string): void {
    let b = this.buckets.get(instanceId);
    if (!b) {
      b = new TokenBucket(this.d.defaults?.burst ?? 20, this.d.defaults?.ratePerSec ?? 10, this.clock);
      this.buckets.set(instanceId, b);
    }
    if (!b.tryTake()) throw new PlatformError('rate-limited', 'connector rate limit reached');
  }

  private breaker(instanceId: string): CircuitBreaker {
    let b = this.breakers.get(instanceId);
    if (!b) {
      b = new CircuitBreaker(this.d.defaults?.breakerThreshold ?? 5, this.d.defaults?.breakerCooldownMs ?? 30_000, this.clock);
      this.breakers.set(instanceId, b);
    }
    return b;
  }

  private digest(req: InvokeRequest): string {
    const safe = JSON.stringify(this.d.redactor.redact(req.input) ?? null);
    return `sha256:${createHash('sha256').update(`${req.capability}\n${safe}`).digest('hex')}`;
  }

  private normalize(e: unknown): PlatformError {
    if (isPlatformError(e)) {
      return new PlatformError(e.errorClass, this.d.redactor.redact(e.message), e.details);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return new PlatformError('internal', this.d.redactor.redact(msg), undefined, e);
  }
}
