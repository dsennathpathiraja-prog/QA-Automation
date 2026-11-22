import {
  Alert,
  Badge,
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
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { ErrorNotice, PageHeader } from './common';
import { errorText } from './connectors/shared';
import { StepArtifact, markdownFromStepPayload } from './StepArtifact';

const key = ['executions'] as const;
const LIVE = new Set(['queued', 'running']);
const WI_LIVE = new Set(['queued', 'running']);
/** How many recently prepared rows the Prepared tab keeps visible. */
const RECENT_PREPARED_LIMIT = 15;
/** Drop preparations older than this from the Prepared tab (still limited by RECENT_PREPARED_LIMIT). */
const RECENT_PREPARED_MS = 72 * 60 * 60 * 1000;
const PREPARED_VISITED_KEY = 'qa.executions.preparedVisitedAt';

function readPreparedVisitedAt(): number {
  try {
    const raw = sessionStorage.getItem(PREPARED_VISITED_KEY);
    if (!raw) return Date.now();
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at : Date.now();
  } catch {
    return Date.now();
  }
}

function writePreparedVisitedAt(at: number) {
  try {
    sessionStorage.setItem(PREPARED_VISITED_KEY, new Date(at).toISOString());
  } catch {
    /* ignore private-mode / blocked storage */
  }
}

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

const CASE_CHIP: Record<string, 'default' | 'success' | 'error' | 'warning' | 'info'> = {
  Queued: 'default',
  Running: 'info',
  Passed: 'success',
  Failed: 'error',
  Blocked: 'warning',
  Skipped: 'default',
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

type ExecTab = 'execution' | 'prepared' | 'history';

function tabOf(raw: unknown): ExecTab {
  if (raw === 'history') return 'history';
  if (raw === 'prepared') return 'prepared';
  return 'execution';
}

export function Executions() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab = tabOf(search.tab);
  const setTab = (next: ExecTab) => {
    void navigate({
      to: '/executions',
      search: (next === 'execution' ? {} : { tab: next }) as never,
    });
  };

  const [selected, setSelected] = useState<string | null>(null);
  const [workItem, setWorkItem] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [preparedVisitedAt, setPreparedVisitedAt] = useState(readPreparedVisitedAt);
  const [justPreparedId, setJustPreparedId] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionStorage.getItem(PREPARED_VISITED_KEY)) writePreparedVisitedAt(preparedVisitedAt);
  }, [preparedVisitedAt]);

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
      setJustPreparedId(row.id);
      setTab('prepared');
      await qc.invalidateQueries({ queryKey: ['work-item-executions'] });
    },
  });
  const run = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/work-item-executions/${id}/run`, {}, WorkItemExecutionSchema),
    onSuccess: async (row) => {
      setOpenRun(row.id);
      setJustPreparedId(null);
      setTab('execution');
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
  const preparedRecent = useMemo(() => {
    const cutoff = Date.now() - RECENT_PREPARED_MS;
    const rows = (board.data?.items ?? []).filter((item) => {
      if (item.status !== 'prepared') return false;
      const created = Date.parse(item.createdAt);
      return Number.isFinite(created) ? created >= cutoff : true;
    });
    return rows.slice(0, RECENT_PREPARED_LIMIT);
  }, [board.data?.items]);
  const unreadPrepared = useMemo(() => {
    return preparedRecent.filter((item) => {
      if (item.id === justPreparedId) return true;
      const created = Date.parse(item.createdAt);
      return Number.isFinite(created) && created > preparedVisitedAt;
    });
  }, [preparedRecent, preparedVisitedAt, justPreparedId]);
  const isNewPrepared = (id: string, createdAt: string) => {
    if (id === justPreparedId) return true;
    const created = Date.parse(createdAt);
    return Number.isFinite(created) && created > preparedVisitedAt;
  };
  const activeRuns = useMemo(() => {
    const rows = board.data?.items ?? [];
    return rows.filter((item) => WI_LIVE.has(item.status) || item.status === 'completed' || item.status === 'failed').slice(0, 20);
  }, [board.data?.items]);
  const stepEvents = (events.data?.items ?? []).filter((event) => event.kind === 'step.completed' || event.kind === 'step.failed');

  useEffect(() => {
    if (tab !== 'prepared') return;
    const at = Date.now();
    setPreparedVisitedAt(at);
    writePreparedVisitedAt(at);
    // Keep justPreparedId so the newest row stays highlighted after the badge clears.
  }, [tab]);

  return (
    <>
      <PageHeader title="Executions" description="Prepare work-item cases, watch live Playwright runs, or review workflow history." />
      <Paper sx={{ mb: 2 }}>
        <Tabs
          value={tab}
          onChange={(_, value: ExecTab) => setTab(value)}
          aria-label="Executions sections"
        >
          <Tab value="execution" label="Execution" id="exec-tab-execution" aria-controls="exec-panel-execution" />
          <Tab
            value="prepared"
            id="exec-tab-prepared"
            aria-controls="exec-panel-prepared"
            label={(
              <Badge
                color="error"
                badgeContent={unreadPrepared.length}
                invisible={tab === 'prepared' || unreadPrepared.length === 0}
                max={9}
                aria-label={unreadPrepared.length > 0 ? `${unreadPrepared.length} new preparations` : undefined}
              >
                <Box component="span" sx={{ pr: unreadPrepared.length > 0 && tab !== 'prepared' ? 1.5 : 0 }}>Prepared test execution</Box>
              </Badge>
            )}
          />
          <Tab value="history" label="History" id="exec-tab-history" aria-controls="exec-panel-history" />
        </Tabs>
      </Paper>

      {tab === 'execution' && (
        <Stack spacing={2} id="exec-panel-execution" role="tabpanel" aria-labelledby="exec-tab-execution">
          <Paper sx={{ p: 2 }} aria-label="Work item">
            <Typography variant="h2" gutterBottom>Prepare work-item run</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Counts match the live Test Cases collection for that work item (soft-deleted cases are excluded). Prepared rows appear on the Prepared test execution tab.
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

          <Paper component="section" sx={{ p: 2 }} aria-label="Setup ready to run">
            <Typography variant="h2" gutterBottom>Ready to run</Typography>
            {preparedRecent.length === 0 ? (
              <Alert severity="info">
                No recent preparations yet. Choose a work item and environment above, then Prepare execution. New rows appear here and on the Prepared test execution tab.
              </Alert>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  {preparedRecent.length} recent {preparedRecent.length === 1 ? 'preparation is' : 'preparations are'} ready
                  {unreadPrepared.length > 0 ? ` · ${unreadPrepared.length} new` : ''}. Open the Prepared tab for the full list, or run from here.
                </Typography>
                <List dense>
                  {preparedRecent.slice(0, 5).map((item) => {
                    const isNew = isNewPrepared(item.id, item.createdAt);
                    return (
                      <ListItem
                        key={item.id}
                        disablePadding
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          px: 1,
                          py: 0.5,
                          bgcolor: isNew ? 'action.selected' : undefined,
                          borderRadius: 1,
                        }}
                      >
                        <ListItemButton
                          selected={openRun === item.id}
                          onClick={() => { setOpenRun(item.id); setTab('prepared'); }}
                          sx={{ flex: '1 1 auto', minWidth: 0, py: 0.75 }}
                        >
                          <ListItemText
                            primary={`${item.workItem} · ${item.environmentName}`}
                            secondary={`${item.caseCount} ${item.caseCount === 1 ? 'case' : 'cases'} · prepared ${new Date(item.createdAt).toLocaleString()}`}
                            slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                            sx={{ minWidth: 0 }}
                          />
                        </ListItemButton>
                        {isNew && <Chip size="small" color="error" label="New" sx={{ flexShrink: 0 }} />}
                        <Chip size="small" label="Prepared" sx={{ flexShrink: 0 }} />
                        <Button size="small" variant="contained" disabled={run.isPending} onClick={() => run.mutate(item.id)} sx={{ flexShrink: 0 }}>
                          Run
                        </Button>
                      </ListItem>
                    );
                  })}
                </List>
                <Box sx={{ mt: 1 }}>
                  <Button size="small" onClick={() => setTab('prepared')}>
                    Open Prepared test execution{unreadPrepared.length > 0 ? ` (${unreadPrepared.length} new)` : ''}
                  </Button>
                </Box>
              </>
            )}
            {run.isError && <ErrorNotice message={errorText(run.error, 'The execution could not be started.')} />}
          </Paper>

          {activeRuns.length > 0 && (
            <Paper sx={{ p: 2 }} aria-label="Live and recent runs">
              <Typography variant="h2" gutterBottom>Live and recent runs</Typography>
              <List dense>
                {activeRuns.map((item) => (
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
                        secondary={countsLabel(item)}
                        slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                        sx={{ minWidth: 0 }}
                      />
                    </ListItemButton>
                    <Chip size="small" label={WI_STATUS[item.status] ?? item.status} sx={{ flexShrink: 0 }} />
                    {item.status === 'failed' && (
                      <Button size="small" variant="contained" disabled={run.isPending} onClick={() => run.mutate(item.id)} sx={{ flexShrink: 0 }}>
                        Run again
                      </Button>
                    )}
                  </ListItem>
                ))}
              </List>
            </Paper>
          )}

          {shown && shown.status !== 'prepared' && (
            <WorkItemRunDetail shown={shown} />
          )}
        </Stack>
      )}

      {tab === 'prepared' && (
        <Stack spacing={2} id="exec-panel-prepared" role="tabpanel" aria-labelledby="exec-tab-prepared">
          <Paper sx={{ p: 2 }} aria-label="Prepared test execution">
            <Typography variant="h2" gutterBottom>Prepared test execution</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Only recently added preparations (last 72 hours, up to {RECENT_PREPARED_LIMIT}). New rows stay highlighted until you leave this tab. Live runs stay on Execution.
            </Typography>
            {board.isError && <ErrorNotice message="Prepared executions could not be loaded." onRetry={() => void board.refetch()} />}
            {board.data && preparedRecent.length === 0 && (
              <Alert severity="info">No recent preparations. Use Prepare execution on the Execution tab.</Alert>
            )}
            {preparedRecent.length > 0 && (
              <List dense>
                {preparedRecent.map((item) => {
                  const isNew = isNewPrepared(item.id, item.createdAt);
                  return (
                    <ListItem
                      key={item.id}
                      disablePadding
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        px: 1,
                        py: 0.5,
                        bgcolor: isNew ? 'action.selected' : undefined,
                        borderRadius: 1,
                      }}
                    >
                      <ListItemButton
                        selected={openRun === item.id}
                        onClick={() => setOpenRun(item.id)}
                        sx={{ flex: '1 1 auto', minWidth: 0, py: 0.75 }}
                      >
                        <ListItemText
                          primary={`${item.workItem} · ${item.environmentName}`}
                          secondary={`${item.caseCount} ${item.caseCount === 1 ? 'case' : 'cases'} · prepared ${new Date(item.createdAt).toLocaleString()}`}
                          slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }}
                          sx={{ minWidth: 0 }}
                        />
                      </ListItemButton>
                      {isNew && <Chip size="small" color="error" label="New" sx={{ flexShrink: 0 }} />}
                      <Chip size="small" label="Prepared" sx={{ flexShrink: 0 }} />
                      <Button size="small" variant="contained" disabled={run.isPending} onClick={() => run.mutate(item.id)} sx={{ flexShrink: 0 }}>
                        Run
                      </Button>
                    </ListItem>
                  );
                })}
              </List>
            )}
            {run.isError && <ErrorNotice message={errorText(run.error, 'The execution could not be started.')} />}
          </Paper>

          {shown?.status === 'prepared' && (
            <Paper sx={{ p: 2 }} aria-label="Prepared run detail">
              <Typography variant="h2" gutterBottom>Ready to run</Typography>
              <Typography>
                {shown.workItem} on {shown.environmentName} · {shown.caseCount} {shown.caseCount === 1 ? 'case' : 'cases'}.
              </Typography>
              <Alert sx={{ mt: 2 }} severity="info">Not run yet. Press Run to execute these cases through the Playwright runner. Live per-case and per-step progress appears on the Execution tab.</Alert>
              <Box sx={{ mt: 2 }}>
                <Button variant="contained" disabled={run.isPending} onClick={() => run.mutate(shown.id)}>Run</Button>
              </Box>
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

function countsLabel(item: { caseCount: number; counts?: { completed: number; passed: number; failed: number; running: number; queued: number } }) {
  if (!item.counts) return `${item.caseCount} ${item.caseCount === 1 ? 'case' : 'cases'}`;
  const { completed, passed, failed, running, queued } = item.counts;
  return `${completed}/${item.caseCount} done · ${passed} passed · ${failed} failed${running ? ` · ${running} running` : ''}${queued ? ` · ${queued} queued` : ''}`;
}

function WorkItemRunDetail({ shown }: { shown: {
  id: string;
  workItem: string;
  environmentName: string;
  caseCount: number;
  status: string;
  squashSync?: string;
  counts?: {
    total: number;
    queued: number;
    running: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    completed: number;
  };
  results?: Array<{
    id: string;
    testCaseId: string;
    name: string;
    status: string;
    message: string;
    hasScreenshot: boolean;
    squashExecutionId?: string;
    steps?: Array<{ name: string; status: string }>;
  }>;
} }) {
  const live = WI_LIVE.has(shown.status);
  return (
    <Paper sx={{ p: 2 }} aria-label="Work item run">
      <Typography variant="h2" gutterBottom>{live ? 'Live run' : 'Run detail'}</Typography>
      <Typography>
        {shown.workItem} on {shown.environmentName} is {WI_STATUS[shown.status]?.toLowerCase() ?? shown.status}.
      </Typography>
      {shown.counts && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 2, flexWrap: 'wrap' }} aria-label="Run counts">
          <Chip size="small" label={`${shown.counts.completed}/${shown.counts.total} completed`} />
          <Chip size="small" color="success" label={`${shown.counts.passed} passed`} />
          <Chip size="small" color="error" label={`${shown.counts.failed} failed`} />
          {shown.counts.blocked > 0 && <Chip size="small" color="warning" label={`${shown.counts.blocked} blocked`} />}
          {shown.counts.running > 0 && <Chip size="small" color="info" label={`${shown.counts.running} running`} />}
          {shown.counts.queued > 0 && <Chip size="small" label={`${shown.counts.queued} queued`} />}
        </Stack>
      )}
      {live && (
        <Alert sx={{ mt: 2 }} severity="info">
          Updating every second while cases run. Per-case status, step progress, and pass/fail counts refresh as the runner reports them.
        </Alert>
      )}
      {shown.squashSync && <Alert sx={{ mt: 2 }} severity="info">{shown.squashSync}</Alert>}
      {shown.results && shown.results.length > 0 && (
        <List sx={{ mt: 1 }}>
          {shown.results.map((row) => (
            <ListItem key={row.id} alignItems="flex-start" sx={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography sx={{ fontWeight: 600 }}>{row.name}</Typography>
                <Chip size="small" label={row.status} color={CASE_CHIP[row.status] ?? 'default'} />
                {row.squashExecutionId && <Chip size="small" variant="outlined" label={`Squash ${row.squashExecutionId}`} />}
              </Stack>
              {row.message && <Typography variant="body2" color="text.secondary">{row.message}</Typography>}
              {row.steps && row.steps.length > 0 && (
                <Stack spacing={0.5} sx={{ mt: 1 }} aria-label={`Steps for ${row.name}`}>
                  {row.steps.map((step, index) => (
                    <Stack key={`${row.id}-step-${index}`} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Chip size="small" variant="outlined" label={step.status} color={CASE_CHIP[step.status] ?? 'default'} />
                      <Typography variant="body2">{step.name}</Typography>
                    </Stack>
                  ))}
                </Stack>
              )}
              {row.status !== 'Queued' && row.status !== 'Running' && (
                row.hasScreenshot
                  ? <CaseScreenshot executionId={shown.id} testCaseId={row.testCaseId} name={row.name} />
                  : (
                    <Alert sx={{ mt: 1 }} severity="info" aria-label={`No screenshot for ${row.name}`}>
                      {screenshotEmptyHint(row.message)}
                    </Alert>
                  )
              )}
            </ListItem>
          ))}
        </List>
      )}
      {shown.status === 'queued' && (!shown.results || shown.results.length === 0) && (
        <Alert sx={{ mt: 2 }} severity="info">Queued. Case placeholders appear when the worker claims this run.</Alert>
      )}
    </Paper>
  );
}

function screenshotEmptyHint(message: string | undefined): string {
  const m = message ?? '';
  if (/HTTP probe|runner-launcher unavailable|runner returned no RESULT_JSON/i.test(m)) {
    return 'No screenshot: this case used an HTTP probe (Playwright capture was not available). Start the runners profile and rebuild qa-runner:local, then re-run.';
  }
  if (/no screenshot/i.test(m)) {
    return m.includes('·') ? m.slice(m.indexOf('·') + 1).trim() : 'No screenshot was captured for this case.';
  }
  return 'No screenshot was captured for this case. With the runners profile up, re-run after rebuilding qa-runner:local so Playwright can capture evidence.';
}

function CaseScreenshot({ executionId, testCaseId, name }: { executionId: string; testCaseId: string; name: string }) {
  const api = useApi();
  const [broken, setBroken] = useState(false);
  const shot = useQuery({
    queryKey: ['work-item-screenshot', executionId, testCaseId],
    queryFn: () => api.get(`/api/v1/work-item-executions/${executionId}/cases/${testCaseId}/screenshot`, WorkItemCaseScreenshot),
  });
  if (shot.isError || broken) {
    return (
      <Alert sx={{ mt: 1 }} severity="warning" aria-label={`Screenshot missing for ${name}`}>
        Screenshot evidence for {name} could not be shown.
      </Alert>
    );
  }
  if (!shot.data) return <Typography variant="body2">Loading screenshot…</Typography>;
  return (
    <Box
      component="img"
      sx={{
        mt: 1,
        display: 'block',
        maxHeight: 240,
        maxWidth: '100%',
        width: 'auto',
        height: 'auto',
        objectFit: 'contain',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        backgroundColor: 'background.paper',
      }}
      alt={`Screenshot evidence for ${name}`}
      src={`data:${shot.data.contentType};base64,${shot.data.pngBase64}`}
      onError={() => setBroken(true)}
    />
  );
}
