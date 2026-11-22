import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { ConnectorListResponse, EnvironmentListResponse, ExecutionEventList, ExecutionListResponse, ExecutionSchema, ValidationReportSchema, WorkflowDefinitionResponse, WorkflowSchema } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import { useSession } from '../../auth/session';
import { ErrorNotice, PageHeader } from '../common';
import { errorText } from '../connectors/shared';
import { findEvidenceExecutionId } from '../run-detail/helpers';
import { StepArtifact, markdownFromStepPayload } from '../StepArtifact';

interface Step { id: string; type: string; enabled?: boolean; mandatory?: boolean; locked?: boolean | string[]; dependsOn?: string[] }
interface ConnectorRow { role: string; category: string; binding?: { connectorInstanceId: string | null } }
interface Param { name: string; type: string; required: boolean; pinned?: unknown }
interface Def { spec?: { steps?: Step[]; connectors?: ConnectorRow[]; parameters?: Param[]; approvals?: { id: string; when: string }[]; execution?: { maxParallelism?: number; timeoutMinutes?: number } } }

const keyOf = (id: string) => ['workflow', id] as const;
const ROLE_LABEL: Record<string, string> = {
  workItemSource: 'Work items',
  browserAutomation: 'Browser',
  sourceRepo: 'Source repository',
  testManagement: 'Squash',
  testRunner: 'Test runner',
};

const STEP_LABEL: Record<string, string> = {
  'rv.read-user-story': 'Read work item',
  'rv.explore-ui': 'Explore UI',
  'rv.explore-code': 'Explore code',
  'rv.consolidate-findings': 'Consolidate findings',
  'rv.generate-test-plan': 'Plan scenarios (Markdown)',
  'rv.generate-tests': 'Generate Playwright cases',
  'rv.heal-tests': 'Heal generated cases',
  'rv.publish-testcases': 'Publish to Test Cases / Squash',
  'rv.execute-tests': 'Execute tests',
  'rv.sync-results': 'Sync results',
  'rv.qa-report': 'QA report',
  'rg.select-squash-project': 'Select Squash project',
  'rg.configure-scope': 'Configure suite / campaign / collection',
  'rg.select-environment': 'Select environment',
  'rg.resolve-automation': 'Resolve approved automation',
  'rg.execute-tests': 'Execute Regression tests',
  'rg.update-squash': 'Update Squash',
  'rg.regression-report': 'Regression report',
};

const STEP_HELP: Record<string, string> = {
  'rv.read-user-story': 'Loads title, description, and acceptance criteria from the work item.',
  'rv.explore-ui': 'Opens the environment and records UI findings for the planner.',
  'rv.explore-code': 'Reads matching source files from the bound Azure DevOps Repos (preferred) or GitHub connector.',
  'rv.consolidate-findings': 'Merges UI and code notes into one findings blob.',
  'rv.generate-test-plan': 'Writes the Markdown test plan artifact with many scenarios and AC coverage gaps.',
  'rv.generate-tests': 'Turns each planned scenario into a Playwright case (quality gate forbids body-only stubs).',
  'rv.heal-tests': 'Rewrites broken platform-owned stubs only.',
  'rv.publish-testcases': 'Stores cases under the work item and upserts Squash when writable; refuses stub-only cases.',
  'rg.select-squash-project': 'Records the Squash project from squashScope for scope expansion.',
  'rg.configure-scope': 'Expands suite, campaign/iteration, or platform collection into Squash case ids.',
  'rg.select-environment': 'Resolves the target application URL for execute.',
  'rg.resolve-automation': 'Approved-only resolve; drafts and unmapped cases become Not Automated.',
  'rg.execute-tests': 'Runs approved scripts via Playwright with evidence on Executions.',
  'rg.update-squash': 'Pushes execution status to Squash when WRITE allows; otherwise degrades with a clear message.',
  'rg.regression-report': 'Writes deterministic regression-report.md (pass/fail/blocked/skipped/Not Automated) with optional previous-run compare.',
};

type WfTab = 'steps' | 'flow' | 'connectors' | 'check' | 'run';

export function WorkflowPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const workflow = useQuery({ queryKey: keyOf(id), queryFn: () => api.get(`/api/v1/workflows/${id}`, WorkflowSchema) });
  const definition = useQuery({ queryKey: [...keyOf(id), 'definition'], queryFn: () => api.get(`/api/v1/workflows/${id}/definition`, WorkflowDefinitionResponse) });
  const [edited, setEdited] = useState<Def | null>(null);
  const [tab, setTab] = useState<WfTab>('steps');
  const [params, setParams] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<'ask' | 'force' | undefined>();
  const savedConnectors = useQuery({ queryKey: ['connectors'], queryFn: () => api.get('/api/v1/connectors', ConnectorListResponse), enabled: session.can('connector.view_status') });
  const environments = useQuery({
    queryKey: ['environments'],
    queryFn: () => api.get('/api/v1/environments', EnvironmentListResponse),
    enabled: session.can('environment.view'),
  });
  const def = edited ?? (definition.data?.definition as Def | undefined);
  const draft = workflow.data?.status === 'draft';
  const canEdit = draft && session.can('workflow.edit');
  const canDelete = session.can('workflow.edit');
  const refresh = async () => { setEdited(null); await qc.invalidateQueries({ queryKey: keyOf(id) }); };

  const save = useMutation({
    mutationFn: () => api.put(`/api/v1/workflows/${id}/definition`, { definition: def }, WorkflowSchema),
    onSuccess: refresh,
  });
  const check = useMutation({ mutationFn: () => api.post(`/api/v1/workflows/${id}/validate`, {}, ValidationReportSchema) });
  const publish = useMutation({ mutationFn: () => api.post(`/api/v1/workflows/${id}/publish-request`, {}, WorkflowSchema), onSuccess: refresh });
  const approve = useMutation({ mutationFn: () => api.post(`/api/v1/workflows/${id}/approve`, {}, WorkflowSchema), onSuccess: refresh });
  const start = useMutation({
    mutationFn: () => {
      const parameters: Record<string, unknown> = { ...params };
      for (const key of ['squashScope', 'selection'] as const) {
        const raw = parameters[key];
        if (typeof raw === 'string' && raw.trim().startsWith('{')) {
          try {
            parameters[key] = JSON.parse(raw) as unknown;
          } catch {
            /* keep string — worker parseRegressionScopeInput also accepts JSON text */
          }
        }
      }
      return api.post(`/api/v1/workflows/${id}/runs`, { parameters }, ExecutionSchema);
    },
    onSuccess: (run) => { setRunId(run.id); setTab('run'); },
  });
  const remove = useMutation({
    mutationFn: (force: boolean) => api.delete(`/api/v1/workflows/${id}${force ? '?force=true' : ''}`),
    onSuccess: async () => {
      setConfirmDelete(undefined);
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      await navigate({ to: '/workflows' });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && /still active/i.test(err.message)) setConfirmDelete('force');
    },
  });
  const runs = useQuery({ queryKey: [...keyOf(id), 'runs'], queryFn: () => api.get(`/api/v1/workflows/${id}/runs`, ExecutionListResponse), enabled: workflow.data?.status === 'published' && session.can('execution.start') });
  const activeId = runId ?? runs.data?.items[0]?.id ?? null;
  const run = useQuery({
    queryKey: ['execution', activeId],
    queryFn: () => api.get(`/api/v1/executions/${activeId}`, ExecutionSchema),
    enabled: Boolean(activeId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? 1000 : false),
  });
  const events = useQuery({
    queryKey: ['execution', activeId, 'events'],
    queryFn: () => api.get(`/api/v1/executions/${activeId}/events`, ExecutionEventList),
    enabled: Boolean(activeId),
    refetchInterval: () => (run.data?.status === 'queued' || run.data?.status === 'running' ? 1000 : false),
  });

  const patch = (next: Def) => setEdited(next);
  const generation = workflow.data?.type === 'requirement-validation';
  const regression = workflow.data?.type === 'regression-testing';
  const steps = (def?.spec?.steps ?? []).filter((s) => !(generation && ['rv.execute-tests', 'rv.sync-results', 'rv.qa-report'].includes(s.type)));
  const enabled = steps.filter((s) => s.enabled !== false);
  const exploreUiOn = enabled.some((s) => s.type === 'rv.explore-ui' || s.id === 'explore_ui');
  const exploreCodeOn = enabled.some((s) => s.type === 'rv.explore-code' || s.id === 'explore_code');
  const selectableEnvironments = (environments.data?.items ?? []).filter((item) => item.enabled && item.selectable);
  const stepEvents = (events.data?.items ?? []).filter((event) => event.kind === 'step.completed' || event.kind === 'step.failed');
  const evidenceExecutionId = findEvidenceExecutionId(events.data?.items);
  const runParams = (def?.spec?.parameters ?? []).filter((p) => {
    if (p.pinned !== undefined && p.pinned !== null) return false;
    if (p.name === 'environment') return exploreUiOn || regression;
    if (p.name === 'acceptPlan') return false; // dedicated checkbox below
    if (p.name === 'browser') return false;
    return p.required;
  });
  const missingEnvironment = (exploreUiOn || regression) && !params.environment;
  const canStartRun = !start.isPending && !((exploreUiOn || regression) && !params.environment);
  const acceptPlanOn = params.acceptPlan === 'true' || params.acceptPlan === '1';
  const pausedForPlan = run.data?.status === 'paused'
    && stepEvents.some((event) => event.kind === 'step.completed' && String(event.payload.stepType ?? '') === 'rv.generate-test-plan')
    && !stepEvents.some((event) => event.kind === 'step.completed' && String(event.payload.stepType ?? '') === 'rv.generate-tests');

  return (
    <>
      <PageHeader title={workflow.data?.name ?? 'Workflow'} description={workflow.data ? `${workflow.data.status}${workflow.data.publishedVersion ? ` · version ${workflow.data.publishedVersion}` : ''}` : 'Loading the workflow.'} />
      <Typography sx={{ mb: 2 }}><Link to="/workflows">All workflows</Link></Typography>
      {workflow.isError && <ErrorNotice message="This workflow could not be loaded." onRetry={() => void workflow.refetch()} />}
      {def && (
        <Stack spacing={2}>
          <Paper>
            <Tabs value={tab} onChange={(_, value: WfTab) => setTab(value)} variant="scrollable" allowScrollButtonsMobile aria-label="Workflow sections">
              <Tab value="steps" label="Steps" />
              <Tab value="flow" label="Flow" />
              <Tab value="connectors" label="Connectors" />
              <Tab value="check" label="Check" />
              <Tab value="run" label="Run & output" />
            </Tabs>
          </Paper>

          {tab === 'steps' && (
            <Paper sx={{ p: 2 }} aria-label="Steps">
              <Typography variant="h2" gutterBottom>Process steps</Typography>
              {generation && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  This workflow ends when test cases are stored. Running the work item against an environment is a separate action on Executions.
                </Alert>
              )}
              {regression && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Regression runs only <strong>approved</strong> Squash↔script mappings. Draft or unmapped cases stay <strong>Not Automated</strong> — never executed, generated, or explored.
                  Approve drafts on <Link to="/automation">Automation Mapping</Link> before you start a run.
                </Alert>
              )}
              {steps.length === 0 && <Alert severity="warning">This draft has no steps. Create it from a template to get the guided list.</Alert>}
              <Stack spacing={1.5}>
                {steps.map((s, index) => {
                  const on = s.enabled !== false;
                  const locked = !canEdit || s.mandatory === true || s.locked === true;
                  return (
                    <Paper key={s.id} variant="outlined" sx={{ p: 1.5, opacity: on ? 1 : 0.65 }}>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                        <Chip size="small" label={`${index + 1}`} />
                        <Box sx={{ flex: 1 }}>
                          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                            <Typography sx={{ fontWeight: 600 }}>{STEP_LABEL[s.type] ?? s.id}</Typography>
                            {s.mandatory && <Chip size="small" color="primary" label="Required" />}
                            {!on && <Chip size="small" label="Off" />}
                          </Stack>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {STEP_HELP[s.type] ?? s.type}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">Id: {s.id}</Typography>
                        </Box>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={on}
                              disabled={locked}
                              onChange={(e) => patch({
                                ...def,
                                spec: {
                                  ...def.spec,
                                  steps: steps.map((x) => (x.id === s.id ? { ...x, enabled: e.target.checked } : x)),
                                },
                              })}
                            />
                          }
                          label="On"
                        />
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            </Paper>
          )}

          {tab === 'flow' && (
            <Paper sx={{ p: 2 }} aria-label="Flow">
              <Typography variant="h2" gutterBottom>Flow</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Read-only order of enabled steps.</Typography>
              {enabled.length === 0 ? (
                <Alert severity="warning">No steps are on.</Alert>
              ) : (
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {enabled.map((s, i) => (
                    <Chip key={s.id} label={`${i + 1}. ${STEP_LABEL[s.type] ?? s.id}`} />
                  ))}
                </Stack>
              )}
            </Paper>
          )}

          {tab === 'connectors' && (
            <Paper sx={{ p: 2 }} aria-label="Connectors">
              <Typography variant="h2" gutterBottom>Connectors</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Choose a connector you already set up. Leave a role on None when that step is turned off. Then Save draft.
              </Typography>
              <Stack spacing={2}>
                {(def.spec?.connectors ?? []).map((c) => {
                  const current = c.binding?.connectorInstanceId ?? '';
                  if (c.category === 'test-runner') {
                    return (
                      <TextField key={c.role} label={ROLE_LABEL[c.role] ?? c.role} value="Platform runner" disabled fullWidth />
                    );
                  }
                  const options = (savedConnectors.data?.items ?? [])
                    .filter((item) => item.category === c.category)
                    .slice()
                    .sort((a, b) => {
                      // Prefer Azure DevOps Repos for Explore code over accidental GitHub/HTML SDK bindings.
                      if (c.role === 'sourceRepo') {
                        const rank = (key: string) => (key === 'azure-devops-repos' ? 0 : key === 'github' ? 2 : 1);
                        const byProvider = rank(a.providerKey) - rank(b.providerKey);
                        if (byProvider !== 0) return byProvider;
                      }
                      return a.name.localeCompare(b.name);
                    });
                  const known = options.some((item) => item.id === current);
                  const azureRepos = options.filter((item) => item.providerKey === 'azure-devops-repos');
                  const bound = options.find((item) => item.id === current);
                  return (
                    <FormControl key={c.role} fullWidth disabled={!canEdit}>
                      <InputLabel id={`role-${c.role}-label`}>{ROLE_LABEL[c.role] ?? c.role}</InputLabel>
                      <Select
                        labelId={`role-${c.role}-label`}
                        id={`role-${c.role}`}
                        label={ROLE_LABEL[c.role] ?? c.role}
                        value={current === 'managed' ? '' : current}
                        onChange={(e) => patch({
                          ...def,
                          spec: {
                            ...def.spec,
                            connectors: (def.spec?.connectors ?? []).map((x) => x.role === c.role
                              ? { ...x, binding: { connectorInstanceId: String(e.target.value) || null } }
                              : x),
                          },
                        })}
                      >
                        <MenuItem value="">None</MenuItem>
                        {current && !known && <MenuItem value={current}>Saved connector</MenuItem>}
                        {options.map((item) => (
                          <MenuItem key={item.id} value={item.id}>
                            {item.name} · {item.providerName}{item.enabled ? '' : ' (disabled)'}
                          </MenuItem>
                        ))}
                      </Select>
                      {c.role === 'sourceRepo' && azureRepos.length > 0 && bound?.providerKey === 'github' && (
                        <Typography variant="caption" color="warning.main" sx={{ mt: 0.5 }}>
                          Azure DevOps Repos is available — bind it for Explore code when the application source lives in Azure Repos (avoids GitHub/HTML SDK hits).
                        </Typography>
                      )}
                      {c.role === 'sourceRepo' && azureRepos.length > 0 && !current && (
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                          Prefer Azure DevOps Repos when the app source is there.
                        </Typography>
                      )}
                    </FormControl>
                  );
                })}
              </Stack>
            </Paper>
          )}

          {tab === 'check' && (
            <Paper sx={{ p: 2 }} aria-label="Check">
              <Typography variant="h2" gutterBottom>Validation</Typography>
              <Button variant="contained" onClick={() => check.mutate()} disabled={check.isPending}>Check this workflow</Button>
              {check.isError && <Box sx={{ mt: 2 }}><ErrorNotice message={errorText(check.error, 'The check failed.')} /></Box>}
              <Stack spacing={1} sx={{ mt: 2 }}>
                {check.data?.issues.map((i, n) => (
                  <Alert key={`${i.ruleId}-${n}`} severity={i.severity === 'warning' ? 'warning' : 'error'}>
                    {i.severity === 'warning' ? 'Warning' : i.ruleId}: {i.message} {i.fixHint}
                  </Alert>
                ))}
                {check.data?.issues.length === 0 && <Alert severity="success">Nothing is blocking publish.</Alert>}
              </Stack>
              {(def.spec?.approvals ?? []).length > 0 && (
                <Typography sx={{ mt: 2 }}>Approvals: {(def.spec?.approvals ?? []).map((a) => a.when).join(', ')}</Typography>
              )}
            </Paper>
          )}

          {tab === 'run' && (
            <Paper sx={{ p: 2 }} aria-label="Run">
              <Typography variant="h2" gutterBottom>Run & step output</Typography>
              {workflow.data?.status !== 'published' && (
                <Alert severity="info">Publish this workflow before starting a run. The worker runs the steps; this page only starts it and shows each step&apos;s output.</Alert>
              )}
              {workflow.data?.status === 'published' && session.can('execution.start') && (
                <Stack component="form" spacing={2} sx={{ mb: 2 }} onSubmit={(e) => { e.preventDefault(); if (!canStartRun) return; start.mutate(); }}>
                  {generation && exploreUiOn && (
                    <Alert severity="info">
                      Explore UI opens the selected environment with Playwright (MCP session → navigate) before planning. Pick an environment so the browser can load the application URL.
                      {exploreCodeOn ? ' Explore code searches the bound source repository before planning.' : ''}
                      {' '}Running prepared cases later is still a separate action on Executions.
                    </Alert>
                  )}
                  {generation && !exploreUiOn && (
                    <Alert severity="info">
                      Starting this run prepares cases
                      {exploreCodeOn ? ' (Explore code searches the bound repository before planning)' : ''}.
                      {' '}Running the work item against an environment is a separate action on Executions.
                    </Alert>
                  )}
                  {generation && (
                    <FormControlLabel
                      control={
                        <Checkbox
                          checked={acceptPlanOn}
                          onChange={(e) => setParams({ ...params, acceptPlan: e.target.checked ? 'true' : 'false' })}
                        />
                      }
                      label="Pause after plan (accept before generate)"
                    />
                  )}
                  {generation && (
                    <Typography variant="caption" color="text.secondary">
                      Publish refuses body-only stubs. Explore-gap / needs-surface cases are flagged; AC coverage gaps appear in the plan Markdown.
                    </Typography>
                  )}
                  {regression && (
                    <Alert severity="warning" sx={{ mb: 1 }}>
                      Approve mappings before you run. Draft or unmapped Squash cases become Not Automated and are skipped — Regression never generates cases or opens explore connectors.
                      Use <Link to="/automation">Automation Mapping</Link> to Approve, then preview resolve.
                    </Alert>
                  )}
                  {regression && (
                    <Alert severity="info">
                      Regression expands squashScope / selection into Squash case ids (<code>rg.configure-scope</code>), then approved-only resolve and execute.
                      Example squashScope JSON: {'{"projectId":"1"}'} or {'{"projectId":"1","campaignId":"10","iterationId":"20"}'}.
                      Selected mode selection: {'{"mode":"selected","caseIds":["238","239"]}'}.
                      {(def?.spec?.parameters ?? []).some((p) => {
                        const pinned = p.pinned && typeof p.pinned === 'object' ? p.pinned as { collectionKey?: string } : undefined;
                        return p.name === 'selection' && pinned?.collectionKey === 'smoke';
                      })
                        ? ' Smoke Regression pins collectionKey smoke — curated platform members, no Squash tags.'
                        : ''}
                    </Alert>
                  )}
                  {runParams.map((p) => (
                    p.name === 'environment' || p.type === 'environment-ref' ? (
                      <FormControl key={p.name} fullWidth required={exploreUiOn || regression} error={missingEnvironment}>
                        <InputLabel id={`param-${p.name}-label`}>Environment</InputLabel>
                        <Select
                          labelId={`param-${p.name}-label`}
                          id={`param-${p.name}`}
                          label="Environment"
                          value={params.environment ?? ''}
                          onChange={(e) => setParams({ ...params, environment: String(e.target.value) })}
                        >
                          <MenuItem value="">Select environment</MenuItem>
                          {selectableEnvironments.map((item) => (
                            <MenuItem key={item.id} value={item.id}>{item.name} · {item.kind}</MenuItem>
                          ))}
                        </Select>
                        {selectableEnvironments.length === 0 && (
                          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                            No selectable environment yet. Create and enable one under Environments, then return here.
                          </Typography>
                        )}
                        {missingEnvironment && selectableEnvironments.length > 0 && (
                          <Typography variant="caption" color="error" sx={{ mt: 0.5 }}>
                            {regression
                              ? 'Environment is required so Regression execute can open the application.'
                              : 'Environment is required so Explore UI can open the application.'}
                          </Typography>
                        )}
                      </FormControl>
                    ) : p.type === 'squash-scope' ? (
                      <TextField
                        key={p.name}
                        id={`param-${p.name}`}
                        label="Squash scope (JSON)"
                        helperText='Project and optional campaign/iteration, e.g. {"projectId":"1"} or {"projectId":"1","campaignId":"10"}.'
                        multiline
                        minRows={3}
                        value={params[p.name] ?? ''}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                        fullWidth
                        required={p.required}
                      />
                    ) : p.type === 'test-case-selection' ? (
                      <TextField
                        key={p.name}
                        id={`param-${p.name}`}
                        label="Case selection (JSON)"
                        helperText='Selected: {"mode":"selected","caseIds":["238"]}. Smoke template pins {"mode":"regression-collection","collectionKey":"smoke"}.'
                        multiline
                        minRows={3}
                        value={params[p.name] ?? ''}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                        fullWidth
                        required={p.required}
                      />
                    ) : (
                      <TextField
                        key={p.name}
                        id={`param-${p.name}`}
                        label={`${p.name} (${p.type})`}
                        helperText={p.type === 'work-item-ref' ? 'Enter the work item id (for example 7189). Bound Azure Boards / Jira load title, description, and acceptance criteria.' : undefined}
                        multiline={p.type === 'work-item-ref'}
                        minRows={p.type === 'work-item-ref' ? 3 : undefined}
                        value={params[p.name] ?? ''}
                        onChange={(e) => setParams({ ...params, [p.name]: e.target.value })}
                        fullWidth
                        required={p.required}
                      />
                    )
                  ))}
                  <Box>
                    <Button type="submit" variant="contained" disabled={!canStartRun}>Start run</Button>
                  </Box>
                  {start.isError && <ErrorNotice message={errorText(start.error, 'The run could not be started.')} />}
                </Stack>
              )}
              {run.data && (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Run {run.data.id.slice(0, 8)} is {run.data.status}, at step {run.data.stepIndex}. A queued run moves when the worker is up.
                </Alert>
              )}
              {pausedForPlan && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  Paused after the test plan so you can review AC coverage and explore-gap notes in the Markdown artifact. Resume on Executions (or send resume) to generate cases.
                </Alert>
              )}
              {evidenceExecutionId && (session.can('report.view') || session.can('evidence.view')) && (
                <Alert severity="success" sx={{ mb: 2 }} aria-label="Open report and evidence">
                  Evidence for this run is on the platform.
                  <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 1, flexWrap: 'wrap' }}>
                    {session.can('report.view') && (
                      <Link to="/runs/$id" params={{ id: evidenceExecutionId }} search={{ view: 'report', from: 'executions' } as never}>
                        <Button size="small" variant="contained">Open report</Button>
                      </Link>
                    )}
                    {session.can('evidence.view') && (
                      <Link to="/runs/$id" params={{ id: evidenceExecutionId }} search={{ view: 'evidence', from: 'executions' } as never}>
                        <Button size="small">Open evidence</Button>
                      </Link>
                    )}
                    <Link to="/executions" search={{ focus: evidenceExecutionId, view: 'evidence' } as never}>
                      <Button size="small">Open on Executions</Button>
                    </Link>
                  </Stack>
                </Alert>
              )}
              {stepEvents.length === 0 && activeId && (
                <Alert severity="info">No step outputs yet. They appear here as each step completes.</Alert>
              )}
              <Stack spacing={1.5}>
                {stepEvents.map((event) => {
                  const stepId = String(event.payload.stepId ?? '');
                  const stepType = String(event.payload.stepType ?? '');
                  const label = STEP_LABEL[stepType] || STEP_LABEL[stepId] || stepId || stepType || event.kind;
                  const summary = typeof event.payload.summary === 'string' ? event.payload.summary : '';
                  const message = typeof event.payload.message === 'string' ? event.payload.message : '';
                  const failed = event.kind === 'step.failed';
                  const output = summary || message;
                  const qualityRefuse = failed && /quality gate|stub-forbidden|Publish refused/i.test(output);
                  const artifact = markdownFromStepPayload(event.payload);
                  return (
                    <Paper key={event.seq} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Chip size="small" color={failed ? 'error' : 'success'} label={failed ? 'Failed' : 'Done'} />
                        <Typography sx={{ fontWeight: 600 }}>{label}</Typography>
                        <Typography variant="caption" color="text.secondary">step #{event.seq}</Typography>
                      </Stack>
                      <Typography variant="subtitle2" color="text.secondary">Output</Typography>
                      {qualityRefuse && (
                        <Alert severity="error" sx={{ mb: 1 }}>
                          Case quality gate refused this step. Fix stub / body-only cases (or regenerate) before publish.
                        </Alert>
                      )}
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                        {output || (failed ? 'This step failed without a summary.' : 'This step completed without a summary.')}
                      </Typography>
                      {artifact && <StepArtifact markdown={artifact.markdown} path={artifact.path} />}
                    </Paper>
                  );
                })}
              </Stack>
            </Paper>
          )}

          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {canEdit && <Button variant="contained" disabled={save.isPending || !edited} onClick={() => save.mutate()}>Save draft</Button>}
            {draft && session.can('workflow.publish.request') && <Button disabled={publish.isPending} onClick={() => publish.mutate()}>Send for approval</Button>}
            {workflow.data?.status === 'in_review' && session.can('workflow.publish.approve') && (
              <Button variant="contained" disabled={approve.isPending} onClick={() => approve.mutate()}>Approve and publish</Button>
            )}
            {canDelete && <Button color="error" disabled={remove.isPending} onClick={() => setConfirmDelete('ask')}>Delete workflow</Button>}
          </Stack>

          {confirmDelete && (
            <Alert severity="warning" role="alertdialog" aria-label="Confirm delete">
              <Typography sx={{ mb: 1 }}>
                {confirmDelete === 'force'
                  ? 'This published workflow still has active runs. Delete it anyway? Queued or running work will lose its workflow, but past run history stays.'
                  : workflow.data?.status === 'published'
                    ? 'Delete this published workflow? You can only do that freely when no run is queued, running, or paused.'
                    : 'Delete this workflow? Drafts and unpublished versions are removed from the list.'}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button variant="contained" color="error" disabled={remove.isPending} onClick={() => remove.mutate(confirmDelete === 'force')}>
                  {confirmDelete === 'force' ? 'Delete anyway' : 'Delete'}
                </Button>
                <Button onClick={() => setConfirmDelete(undefined)}>Cancel</Button>
              </Stack>
            </Alert>
          )}
          {(save.isError || publish.isError || approve.isError || (remove.isError && !(remove.error instanceof ApiError && remove.error.status === 409 && /still active/i.test(remove.error.message)))) && (
            <ErrorNotice message={errorText(save.error ?? publish.error ?? approve.error ?? remove.error, 'That change was rejected.')} />
          )}
        </Stack>
      )}
    </>
  );
}
