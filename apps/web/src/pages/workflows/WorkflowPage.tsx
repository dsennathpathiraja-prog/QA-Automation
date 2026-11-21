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
};

const STEP_HELP: Record<string, string> = {
  'rv.read-user-story': 'Loads title, description, and acceptance criteria from the work item.',
  'rv.explore-ui': 'Opens the environment and records UI findings for the planner.',
  'rv.explore-code': 'Reads matching source files (read-only) for the planner.',
  'rv.consolidate-findings': 'Merges UI and code notes into one findings blob.',
  'rv.generate-test-plan': 'Writes the Markdown test plan artifact with many scenarios.',
  'rv.generate-tests': 'Turns each planned scenario into a Playwright case.',
  'rv.heal-tests': 'Rewrites broken platform-owned stubs only.',
  'rv.publish-testcases': 'Stores cases under the work item and upserts Squash when writable.',
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
    mutationFn: () => api.post(`/api/v1/workflows/${id}/runs`, { parameters: params }, ExecutionSchema),
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
  const steps = (def?.spec?.steps ?? []).filter((s) => !(generation && ['rv.execute-tests', 'rv.sync-results', 'rv.qa-report'].includes(s.type)));
  const enabled = steps.filter((s) => s.enabled !== false);
  const exploreUiOn = enabled.some((s) => s.type === 'rv.explore-ui' || s.id === 'explore_ui');
  const selectableEnvironments = (environments.data?.items ?? []).filter((item) => item.enabled && item.selectable);
  const stepEvents = (events.data?.items ?? []).filter((event) => event.kind === 'step.completed' || event.kind === 'step.failed');
  const runParams = (def?.spec?.parameters ?? []).filter((p) => {
    if (p.pinned !== undefined && p.pinned !== null) return false;
    if (p.name === 'environment') return exploreUiOn;
    return p.required;
  });
  const missingEnvironment = exploreUiOn && !params.environment;
  const canStartRun = !start.isPending && !(exploreUiOn && !params.environment);

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
                  const options = (savedConnectors.data?.items ?? []).filter((item) => item.category === c.category);
                  const known = options.some((item) => item.id === current);
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
                          <MenuItem key={item.id} value={item.id}>{item.name}{item.enabled ? '' : ' (disabled)'}</MenuItem>
                        ))}
                      </Select>
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
                      Explore UI opens the selected environment before planning. Pick an environment here so the browser can load the application URL.
                      Running prepared cases later is still a separate action on Executions.
                    </Alert>
                  )}
                  {generation && !exploreUiOn && (
                    <Alert severity="info">
                      Starting this run creates the test cases. Running the work item against an environment is a separate action on Executions.
                    </Alert>
                  )}
                  {runParams.map((p) => (
                    p.name === 'environment' || p.type === 'environment-ref' ? (
                      <FormControl key={p.name} fullWidth required={exploreUiOn} error={missingEnvironment}>
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
                            Environment is required so Explore UI can open the application.
                          </Typography>
                        )}
                      </FormControl>
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
                  return (
                    <Paper key={event.seq} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Chip size="small" color={failed ? 'error' : 'success'} label={failed ? 'Failed' : 'Done'} />
                        <Typography sx={{ fontWeight: 600 }}>{label}</Typography>
                        <Typography variant="caption" color="text.secondary">step #{event.seq}</Typography>
                      </Stack>
                      <Typography variant="subtitle2" color="text.secondary">Output</Typography>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                        {output || (failed ? 'This step failed without a summary.' : 'This step completed without a summary.')}
                      </Typography>
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
