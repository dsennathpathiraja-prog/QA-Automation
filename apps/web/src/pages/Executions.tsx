import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { ExecutionEventList, ExecutionListResponse, ExecutionSchema, WorkItemCaseScreenshot, WorkItemExecutionBoard, WorkItemExecutionSchema } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { ErrorNotice, PageHeader } from './common';
import { errorText } from './connectors/shared';
import { StepArtifact, markdownFromStepPayload } from './StepArtifact';

const key = ['executions'] as const;
const LIVE = new Set(['queued', 'running']);
const WI_LIVE = new Set(['queued', 'running']);

const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const WI_STATUS: Record<string, string> = {
  prepared: 'Prepared',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

const STEP_LABEL: Record<string, string> = {
  read_story: 'Read work item',
  explore_ui: 'Explore UI',
  explore_code: 'Explore code',
  consolidate: 'Consolidate findings',
  plan: 'Plan scenarios',
  generate_tests: 'Generate tests',
  heal_tests: 'Heal tests',
  publish_testcases: 'Publish to Test Cases / Squash',
  'rv.read-user-story': 'Read work item',
  'rv.explore-ui': 'Explore UI',
  'rv.explore-code': 'Explore code',
  'rv.consolidate-findings': 'Consolidate findings',
  'rv.generate-test-plan': 'Plan scenarios',
  'rv.generate-tests': 'Generate tests',
  'rv.heal-tests': 'Heal tests',
  'rv.publish-testcases': 'Publish to Test Cases / Squash',
};

type ExecTab = 'execution' | 'history';

function tabOf(raw: unknown): ExecTab {
  return raw === 'history' ? 'history' : 'execution';
}

export function Executions() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab = tabOf(search.tab);
  const setTab = (next: ExecTab) => {
    void navigate({ to: '/executions', search: (next === 'history' ? { tab: 'history' } : {}) as never });
  };

  const [selected, setSelected] = useState<string | null>(null);
  const [workItem, setWorkItem] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ['work-item-executions'],
    queryFn: () => api.get('/api/v1/work-item-executions', WorkItemExecutionBoard),
    refetchInterval: (q) => (q.state.data?.items.some((item) => WI_LIVE.has(item.status)) ? 2000 : false),
  });
  const detail = useQuery({
    queryKey: ['work-item-execution', openRun],
    queryFn: () => api.get(`/api/v1/work-item-executions/${openRun}`, WorkItemExecutionSchema),
    enabled: Boolean(openRun),
    refetchInterval: (q) => (q.state.data && WI_LIVE.has(q.state.data.status) ? 1000 : false),
  });
  const prepare = useMutation({
    mutationFn: () => api.post('/api/v1/work-item-executions', { workItem, environmentId }, WorkItemExecutionSchema),
    onSuccess: async (row) => {
      setOpenRun(row.id);
      await qc.invalidateQueries({ queryKey: ['work-item-executions'] });
    },
  });
  const run = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/work-item-executions/${id}/run`, {}, WorkItemExecutionSchema),
    onSuccess: async (row) => {
      setOpenRun(row.id);
      await qc.invalidateQueries({ queryKey: ['work-item-executions'] });
      await qc.invalidateQueries({ queryKey: ['work-item-execution', row.id] });
    },
  });
  const runs = useQuery({
    queryKey: key,
    queryFn: () => api.get('/api/v1/executions', ExecutionListResponse),
    refetchInterval: (q) => (q.state.data?.items.some((item) => LIVE.has(item.status)) ? 2000 : false),
  });
  const events = useQuery({
    queryKey: ['execution', selected, 'events'],
    queryFn: () => api.get(`/api/v1/executions/${selected}/events`, ExecutionEventList),
    enabled: Boolean(selected),
    refetchInterval: () => {
      const status = runs.data?.items.find((item) => item.id === selected)?.status;
      return status === 'queued' || status === 'running' ? 1000 : false;
    },
  });
  const control = useMutation({
    mutationFn: (command: 'pause' | 'resume' | 'cancel') => api.post(`/api/v1/executions/${selected}/${command}`, {}, ExecutionSchema),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['execution', selected, 'events'] });
    },
  });

  const items = runs.data?.items ?? [];
  const current = items.find((item) => item.id === selected);
  const open = current && current.status !== 'succeeded' && current.status !== 'failed' && current.status !== 'cancelled';
  const shown = detail.data ?? board.data?.items.find((item) => item.id === openRun);
  const selectedWorkItem = useMemo(
    () => board.data?.workItems.find((item) => item.workItem === workItem),
    [board.data?.workItems, workItem],
  );
  const stepEvents = (events.data?.items ?? []).filter((event) => event.kind === 'step.completed' || event.kind === 'step.failed');

  return (
    <>
      <PageHeader title="Executions" description="Run live work-item cases on an environment, or review workflow run history." />
      <Paper sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_, value: ExecTab) => setTab(value)} aria-label="Executions sections">
          <Tab value="execution" label="Execution" id="exec-tab-execution" aria-controls="exec-panel-execution" />
          <Tab value="history" label="History" id="exec-tab-history" aria-controls="exec-panel-history" />
        </Tabs>
      </Paper>

      {tab === 'execution' && (
        <Stack spacing={2} id="exec-panel-execution" role="tabpanel" aria-labelledby="exec-tab-execution">
          <Paper sx={{ p: 2 }} aria-label="Work item">
            <Typography variant="h2" gutterBottom>Prepare work-item run</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Counts match the live Test Cases collection for that work item (soft-deleted cases are excluded).
            </Typography>
            {board.isError && <ErrorNotice message="Work item executions could not be loaded." onRetry={() => void board.refetch()} />}
            {board.data && board.data.workItems.length === 0 && (
              <Alert severity="info">No work item has a live test-case collection yet. Run a requirement-validation workflow first.</Alert>
            )}
            {board.data && board.data.workItems.length > 0 && (
              <Stack component="form" spacing={2} onSubmit={(e) => { e.preventDefault(); prepare.mutate(); }}>
                <FormControl fullWidth required>
                  <InputLabel id="exec-work-item-label">Work item collection</InputLabel>
                  <Select
                    labelId="exec-work-item-label"
                    id="exec-work-item"
                    label="Work item collection"
                    value={workItem}
                    onChange={(e) => setWorkItem(String(e.target.value))}
                  >
                    {board.data.workItems.map((item) => (
                      <MenuItem key={item.workItem} value={item.workItem}>
                        {item.workItem} · {item.caseCount} {item.caseCount === 1 ? 'case' : 'cases'}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {selectedWorkItem && (
                  <Alert severity="success" variant="outlined">
                    Selected collection <strong>{selectedWorkItem.workItem}</strong> has{' '}
                    <strong>{selectedWorkItem.caseCount}</strong> live {selectedWorkItem.caseCount === 1 ? 'case' : 'cases'}.
                  </Alert>
                )}
                <FormControl fullWidth required>
                  <InputLabel id="exec-environment-label">Environment</InputLabel>
                  <Select
                    labelId="exec-environment-label"
                    id="exec-environment"
                    label="Environment"
                    value={environmentId}
                    onChange={(e) => setEnvironmentId(String(e.target.value))}
                  >
                    {board.data.environments.map((item) => (
                      <MenuItem key={item.id} value={item.id}>{item.name} · {item.kind}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {board.data.environments.length === 0 && <Alert severity="warning">No environment can be selected yet.</Alert>}
                <Box>
                  <Button type="submit" variant="contained" disabled={prepare.isPending || board.data.environments.length === 0 || !workItem}>
                    Prepare execution
                  </Button>
                </Box>
                {prepare.isError && <ErrorNotice message={errorText(prepare.error, 'The execution could not be prepared.')} />}
              </Stack>
            )}
          </Paper>

          {board.data && board.data.items.length > 0 && (
            <Paper sx={{ p: 2 }} aria-label="Prepared runs">
              <Typography variant="h2" gutterBottom>Prepared and recent runs</Typography>
              <List dense>
                {board.data.items.map((item) => (
                  <ListItem
                    key={item.id}
                    disablePadding
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5 }}
                  >
                    <ListItemButton
                      selected={openRun === item.id}
                      onClick={() => setOpenRun(item.id)}
                      sx={{ flex: '1 1 auto', minWidth: 0, py: 0.75 }}
                    >
                      <ListItemText
                        primary={`${item.workItem} · ${item.environmentName}`}
                        secondary={`${item.caseCount} ${item.caseCount === 1 ? 'case' : 'cases'}`}
                        slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                        sx={{ minWidth: 0 }}
                      />
                    </ListItemButton>
                    <Chip size="small" label={WI_STATUS[item.status] ?? item.status} sx={{ flexShrink: 0 }} />
                    {(item.status === 'prepared' || item.status === 'failed') && (
                      <Button size="small" variant="contained" disabled={run.isPending} onClick={() => run.mutate(item.id)} sx={{ flexShrink: 0 }}>
                        Run
                      </Button>
                    )}
                  </ListItem>
                ))}
              </List>
              {run.isError && <ErrorNotice message={errorText(run.error, 'The execution could not be started.')} />}
            </Paper>
          )}

          {shown && (
            <Paper sx={{ p: 2 }} aria-label="Work item run">
              <Typography variant="h2" gutterBottom>Run detail</Typography>
              <Typography>
                {shown.workItem} on {shown.environmentName} is {WI_STATUS[shown.status]?.toLowerCase() ?? shown.status}.
              </Typography>
              {shown.squashSync && <Alert sx={{ mt: 2 }} severity="info">{shown.squashSync}</Alert>}
              {shown.results && shown.results.length > 0 && (
                <List sx={{ mt: 1 }}>
                  {shown.results.map((row) => (
                    <ListItem key={row.id} alignItems="flex-start" sx={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 600 }}>{row.name}</Typography>
                        <Chip size="small" label={row.status} color={row.status === 'Passed' ? 'success' : row.status === 'Failed' ? 'error' : 'default'} />
                        {row.squashExecutionId && <Chip size="small" variant="outlined" label={`Squash ${row.squashExecutionId}`} />}
                      </Stack>
                      {row.message && <Typography variant="body2" color="text.secondary">{row.message}</Typography>}
                      {row.hasScreenshot && <CaseScreenshot executionId={shown.id} testCaseId={row.testCaseId} name={row.name} />}
                    </ListItem>
                  ))}
                </List>
              )}
              {shown.status === 'prepared' && (
                <Alert sx={{ mt: 2 }} severity="info">Not run yet. Press Run to execute these cases through the Playwright runner.</Alert>
              )}
            </Paper>
          )}
        </Stack>
      )}

      {tab === 'history' && (
        <Stack spacing={2} id="exec-panel-history" role="tabpanel" aria-labelledby="exec-tab-history">
          <Paper sx={{ p: 2 }} aria-label="Workflow runs">
            <Typography variant="h2" gutterBottom>Workflow run history</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              These runs create and publish test cases. They are not the work-item Playwright execution.
            </Typography>
            {runs.isError && <ErrorNotice message="Runs could not be loaded." onRetry={() => void runs.refetch()} />}
            {runs.data && items.length === 0 && <Alert severity="info">No workflow runs yet. Start one from a published workflow.</Alert>}
            {items.length > 0 && (
              <List dense>
                {items.map((item) => (
                  <ListItem
                    key={item.id}
                    disablePadding
                    sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5 }}
                  >
                    <ListItemButton
                      selected={selected === item.id}
                      onClick={() => setSelected(item.id)}
                      sx={{ flex: '1 1 auto', minWidth: 0, py: 0.75 }}
                    >
                      <ListItemText
                        primary={item.workflowName}
                        secondary={`step ${item.stepIndex} · ${item.id.slice(0, 8)}`}
                        slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                        sx={{ minWidth: 0 }}
                      />
                    </ListItemButton>
                    <Chip size="small" label={STATUS[item.status] ?? item.status} sx={{ flexShrink: 0 }} />
                    <Box sx={{ flexShrink: 0 }}>
                      <Link to="/workflows/$id" params={{ id: item.workflowId }}>
                        <Button size="small">Open workflow</Button>
                      </Link>
                    </Box>
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>

          {current && (
            <Paper component="section" sx={{ p: 2 }} aria-label="Selected run">
              <Typography variant="h2" gutterBottom>Step timeline</Typography>
              <Typography sx={{ mb: 2 }}>
                {current.workflowName} is {STATUS[current.status]?.toLowerCase() ?? current.status}, at step {current.stepIndex}.
              </Typography>
              {session.can('execution.control') && open && (
                <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                  {current.status === 'paused'
                    ? <Button variant="contained" disabled={control.isPending} onClick={() => control.mutate('resume')}>Resume</Button>
                    : <Button disabled={control.isPending} onClick={() => control.mutate('pause')}>Pause</Button>}
                  <Button color="error" disabled={control.isPending} onClick={() => control.mutate('cancel')}>Cancel</Button>
                </Stack>
              )}
              {control.isError && <ErrorNotice message={errorText(control.error, 'That command was rejected.')} />}
              {events.isError && <ErrorNotice message="The step history could not be loaded." onRetry={() => void events.refetch()} />}
              {events.data && stepEvents.length === 0 && <Alert severity="info">This run has no recorded steps yet.</Alert>}
              {stepEvents.length > 0 && (
                <Stack spacing={1.5}>
                  {stepEvents.map((event) => {
                    const stepId = String(event.payload.stepId ?? '');
                    const stepType = String(event.payload.stepType ?? '');
                    const label = STEP_LABEL[stepId] || STEP_LABEL[stepType] || stepId || stepType || event.kind;
                    const summary = typeof event.payload.summary === 'string' ? event.payload.summary : '';
                    const message = typeof event.payload.message === 'string' ? event.payload.message : '';
                    const failed = event.kind === 'step.failed';
                    const output = summary || message;
                    const artifact = markdownFromStepPayload(event.payload);
                    return (
                      <Paper key={event.seq} variant="outlined" sx={{ p: 1.5 }}>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Chip size="small" color={failed ? 'error' : 'success'} label={failed ? 'Failed' : 'Done'} />
                          <Typography sx={{ fontWeight: 600 }}>{label}</Typography>
                          <Typography variant="caption" color="text.secondary">#{event.seq}</Typography>
                        </Stack>
                        <Typography variant="subtitle2" color="text.secondary">Output</Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          {output || (failed ? 'This step failed without a summary.' : 'This step completed without a summary.')}
                        </Typography>
                        {artifact && <StepArtifact markdown={artifact.markdown} path={artifact.path} />}
                      </Paper>
                    );
                  })}
                </Stack>
              )}
            </Paper>
          )}
        </Stack>
      )}
    </>
  );
}

function CaseScreenshot({ executionId, testCaseId, name }: { executionId: string; testCaseId: string; name: string }) {
  const api = useApi();
  const shot = useQuery({
    queryKey: ['work-item-screenshot', executionId, testCaseId],
    queryFn: () => api.get(`/api/v1/work-item-executions/${executionId}/cases/${testCaseId}/screenshot`, WorkItemCaseScreenshot),
  });
  if (shot.isError) return <Typography variant="body2">Screenshot for {name} could not be loaded.</Typography>;
  if (!shot.data) return <Typography variant="body2">Loading screenshot…</Typography>;
  return (
    <Box
      component="img"
      sx={{ mt: 1, maxHeight: 192, border: 1, borderColor: 'divider', borderRadius: 1 }}
      alt={`Screenshot for ${name}`}
      src={`data:image/png;base64,${shot.data.pngBase64}`}
    />
  );
}
