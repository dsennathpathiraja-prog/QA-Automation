import type { FastifyInstance } from 'fastify';
import {
  AutomationAssetListResponse,
  AutomationAssetSchema,
  AutomationMappingListResponse,
  AutomationResolveResponse,
  CreateAutomationMappingRequest,
  RegisterAutomationAssetRequest,
  RegressionResolveRequest,
  RegressionResolveResponse,
  RegressionScopeRequest,
  RegressionScopeResponse,
} from '@qa/contracts';
import { PlatformError } from '@qa/domain';
import {
  parseRegressionScopeInput,
  type AutomationService,
  type RegressionScopeService,
} from '@qa/application';
import { requires } from '@qa/security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown, what: string): T => {
  const r = schema.safeParse(raw);
  if (!r.success) throw new PlatformError('validation', `The ${what} request is not valid.`);
  return r.data;
};

const idOf = (raw: unknown, what: string) => {
  const id = String(raw);
  if (!UUID.test(id)) throw new PlatformError('not-found', `${what} not found`);
  return id;
};

export function registerAutomationRoutes(
  app: FastifyInstance,
  automation: AutomationService,
  scope?: RegressionScopeService,
) {
  app.get('/api/v1/automation/assets', { config: { access: requires('automation.view') } }, async (req) => {
    const status = (req.query as { status?: string }).status;
    const filter = status === 'draft' || status === 'approved' ? status : undefined;
    return AutomationAssetListResponse.parse({ items: await automation.listAssets(filter) });
  });

  app.get('/api/v1/automation/assets/:id', { config: { access: requires('automation.view') } }, async (req) => {
    return AutomationAssetSchema.parse(await automation.getAsset(idOf((req.params as { id: string }).id, 'Automation asset')));
  });

  app.post('/api/v1/automation/assets', { config: { access: requires('automation.register') } }, async (req, reply) => {
    const created = await automation.register({ id: req.principal!.id }, body(RegisterAutomationAssetRequest, req.body, 'register automation asset'));
    return reply.code(201).send(AutomationAssetSchema.parse(created));
  });

  app.post('/api/v1/automation/assets/:id/approve', { config: { access: requires('automation.approve') } }, async (req) => {
    const saved = await automation.approve({ id: req.principal!.id }, idOf((req.params as { id: string }).id, 'Automation asset'));
    return AutomationAssetSchema.parse(saved);
  });

  app.get('/api/v1/automation/mappings', { config: { access: requires('automation.view') } }, async () => {
    return AutomationMappingListResponse.parse({ items: await automation.listMappings() });
  });

  app.post('/api/v1/automation/mappings', { config: { access: requires('automation.register') } }, async (req, reply) => {
    const input = body(CreateAutomationMappingRequest, req.body, 'create automation mapping');
    const mapping = await automation.linkSquash({ id: req.principal!.id }, input);
    const resolved = await automation.resolveBySquashCaseId(mapping.squashCaseId);
    return reply.code(201).send(AutomationResolveResponse.parse(resolved));
  });

  /** Squash case id → platform automation asset id (Regression seed; draft or approved). */
  app.get('/api/v1/automation/resolve', { config: { access: requires('automation.view') } }, async (req) => {
    const squashCaseId = String((req.query as { squashCaseId?: string }).squashCaseId ?? '').trim();
    if (!squashCaseId) throw new PlatformError('validation', 'Query parameter squashCaseId is required.');
    return AutomationResolveResponse.parse(await automation.resolveBySquashCaseId(squashCaseId));
  });

  /**
   * Phase 9 E1 — Regression prep: approved-only resolve.
   * Draft / unmapped / missing asset → Not Automated (never executed or generated).
   */
  app.post('/api/v1/automation/resolve-regression', { config: { access: requires('automation.view') } }, async (req) => {
    const input = body(RegressionResolveRequest, req.body, 'resolve regression automation');
    return RegressionResolveResponse.parse(await automation.resolveForRegression(input.squashCaseIds));
  });

  /**
   * Phase 9 E3 — expand suite / campaign / collection / selected into Squash case ids for resolve.
   * Suite/campaign without Squash on the API: pass `caseIds` (worker `rg.configure-scope` does live Squash).
   */
  app.post('/api/v1/automation/scope', { config: { access: requires('automation.view') } }, async (req) => {
    if (!scope) throw new PlatformError('denied', 'Regression scope is not configured on this API.');
    const raw = body(RegressionScopeRequest, req.body, 'regression scope');
    const input = parseRegressionScopeInput(raw);
    return RegressionScopeResponse.parse(await scope.resolve(input));
  });
}
