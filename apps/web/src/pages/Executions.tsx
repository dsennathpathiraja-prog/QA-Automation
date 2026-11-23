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
import { ExecutionEventList, ExecutionListResponse, ExecutionSchema, WorkItemExecutionBoard, WorkItemExecutionSchema } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { useProject } from '../project/ProjectContext';
import { ErrorNotice, PageHeader } from './common';
import { errorText } from './connectors/shared';
import { countsLabel, findEvidenceExecutionId, parseRunDetailView, type RunDetailView, WI_LIVE, WI_STATUS } from './run-detail/helpers';
import { WorkItemRunDetail } from './run-detail/WorkItemRunDetail';
import { StepArtifact, markdownFromStepPayload } from './StepArtifact';

const executionsKey = (projectId: string | null | undefined) => ['executions', projectId] as const;
const boardKey = (projectId: string | null | undefined) => ['work-item-executions', projectId] as const;
const LIVE = new Set(['queued', 'running']);
const FINISHED_RUN = new Set(['completed', 'failed', 'cancelled']);
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
  const { selectedId } = useProject();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    tab?: string;
    focus?: string;
    view?: string;
    case?: string;
  };
  const tab = tabOf(search.tab);
  const focusFromUrl = typeof search.focus === 'string' && search.focus.trim() ? search.focus.trim() : null;
  const focusCase = typeof search.case === 'string' && search.case.trim() ? search.case.trim() : null;
  const detailView: RunDetailView = parseRunDetailView(search.view);
  const setTab = (next: ExecTab) => {
    void navigate({
      to: '/executions',
      search: {
        ...(next === 'execution' ? {} : { tab: next }),
        ...(focusFromUrl ? { focus: focusFromUrl } : {}),
        ...(detailView !== 'summary' ? { view: detailView } : {}),
        ...(focusCase ? { case: focusCase } : {}),
      } as never,
    });
  };
  const [selected, setSelected] = useState<string | null>(null);
  const [workItem, setWorkItem] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [openRun, setOpenRun] = useState<string | null>(focusFromUrl);
  const [preparedVisitedAt, setPreparedVisitedAt] = useState(readPreparedVisitedAt);
  const [justPreparedId, setJustPreparedId] = useState<string | null>(null);

  const selectRun = (id: string | null, view: RunDetailView = detailView) => {
    setOpenRun(id);
    void navigate({
      to: '/executions',
      search: {
        ...(tab === 'execution' ? {} : { tab }),
        ...(id ? { focus: id } : {}),
        ...(view !== 'summary' ? { view } : {}),
        ...(focusCase ? { case: focusCase } : {}),
      } as never,
    });
  };
  const setDetailView = (view: RunDetailView) => {
    const id = focusFromUrl ?? openRun;
    if (!id) return;
    void navigate({
      to: '/executions',
      search: {
        ...(tab === 'execution' ? {} : { tab }),
        focus: id,
        ...(view !== 'summary' ? { view } : {}),
        ...(focusCase ? { case: focusCase } : {}),
      } as never,
    });
  };

  useEffect(() => {
    if (focusFromUrl) setOpenRun(focusFromUrl);
  }, [focusFromUrl]);

  useEffect(() => {
    setWorkItem('');
    setEnvironmentId('');
    setSelected(null);
    setJustPreparedId(null);
  }, [selectedId]);

  useEffect(() => {
    if (!sessionStorage.getItem(PREPARED_VISITED_KEY)) writePreparedVisitedAt(preparedVisitedAt);
  }, [preparedVisitedAt]);

  const board = useQuery({
    queryKey: boardKey(selectedId),
    queryFn: () => api.get(`/api/v1/work-item-executions?projectId=${encodeURIComponent(selectedId!)}`, WorkItemExecutionBoard),
    enabled: Boolean(selectedId),
    refetchInterval: (q) => (q.state.data?.items.some((item) => WI_LIVE.has(item.status)) ? 2000 : false),
  });
  const detail = useQuery({
    queryKey: ['work-item-execution', openRun],
    queryFn: () => api.get(`/api/v1/work-item-executions/${openRun}`, WorkItemExecutionSchema),
    enabled: Boolean(openRun),
    refetchInterval: (q) => (q.state.data && WI_LIVE.has(q.state.data.status) ? 1000 : false),
  });
  const prepare = useMutation({
    mutationFn: () => api.post('/api/v1/work-item-executions', { projectId: selectedId!, workItem, environmentId }, WorkItemExecutionSchema),
    onSuccess: async (row) => {
      setJustPreparedId(row.id);
      setOpenRun(row.id);
      setTab('prepared');
      await qc.invalidateQueries({ queryKey: boardKey(selectedId) });
    },
  });
  const run = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/work-item-executions/${id}/run`, {}, WorkItemExecutionSchema),
    onSuccess: async (row) => {
      setJustPreparedId(null);
      selectRun(row.id, 'summary');
      setTab('execution');
      await qc.invalidateQueries({ queryKey: boardKey(selectedId) });
      await qc.invalidateQueries({ queryKey: ['work-item-execution', row.id] });
    },
  });
  const cancelWorkItem = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/work-item-executions/${id}/cancel`, {}, WorkItemExecutionSchema),
    onSuccess: async (row) => {
      selectRun(row.id, detailView);
      await qc.invalidateQueries({ queryKey: boardKey(selectedId) });
      await qc.invalidateQueries({ queryKey: ['work-item-execution', row.id] });
    },
  });
  const runs = useQuery({
    queryKey: executionsKey(selectedId),
    queryFn: () => api.get(`/api/v1/executions?projectId=${encodeURIComponent(selectedId!)}`, ExecutionListResponse),
    enabled: Boolean(selectedId),
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
      await qc.invalidateQueries({ queryKey: executionsKey(selectedId) });
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
    return rows.filter((item) => WI_LIVE.has(item.status) || item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled').slice(0, 20);
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
      <PageHeader title="Executions" description="Prepare work-item cases, watch Regression and Playwright runs, or review workflow history." />
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
          <Paper component="section" sx={{ p: 2 }} aria-label="Regression">
            <Typography variant="h2" gutterBottom>Regression</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Full / Selected / Smoke Regression starts from a published Regression workflow (Run &amp; output). After a run finishes, open Report or Evidence — workflow-created cases stay in Squash; Mapping CRUD is not required for review.
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              <Link to="/workflows">
                <Button variant="contained">Open Workflows</Button>
              </Link>
              {session.can('report.view') && (
                <Link to="/reports">
                  <Button>Reports</Button>
                </Link>
              )}
              {session.can('evidence.view') && (
                <Link to="/evidence">
                  <Button>Evidence</Button>
                </Link>
              )}
            </Stack>
          </Paper>
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
                      onClick={() => selectRun(item.id)}
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
                    {FINISHED_RUN.has(item.status) && session.can('report.view') && (
                      <Link to="/runs/$id" params={{ id: item.id }} search={{ view: 'report', from: 'executions' } as never}>
                        <Button size="small" sx={{ flexShrink: 0 }}>Report</Button>
                      </Link>
                    )}
                    {FINISHED_RUN.has(item.status) && session.can('evidence.view') && (
                      <Link to="/runs/$id" params={{ id: item.id }} search={{ view: 'evidence', from: 'executions' } as never}>
                        <Button size="small" sx={{ flexShrink: 0 }}>Evidence</Button>
                      </Link>
                    )}
                    {WI_LIVE.has(item.status) && session.can('execution.control') && (
                      <Button size="small" color="error" disabled={cancelWorkItem.isPending} onClick={() => cancelWorkItem.mutate(item.id)} sx={{ flexShrink: 0 }}>
                        Cancel
                      </Button>
                    )}
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
          {cancelWorkItem.isError && <ErrorNotice message={errorText(cancelWorkItem.error, 'That work-item run could not be cancelled.')} />}

          {shown && shown.status !== 'prepared' && (
            <WorkItemRunDetail
              shown={shown}
              view={detailView}
              onViewChange={setDetailView}
              focusCaseId={focusCase}
              onCancel={session.can('execution.control') && WI_LIVE.has(shown.status) ? () => cancelWorkItem.mutate(shown.id) : undefined}
              cancelPending={cancelWorkItem.isPending}
            />
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
              <Alert sx={{ mt: 2 }} severity="info">Not run yet. Press Run to execute these cases through the Playwright runner (requires runner-launcher / qa-runner:local from the local compose stack). Live per-case and per-step progress appears on the Execution tab.</Alert>
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
              Requirement-validation runs create and publish test cases. Regression runs resolve approved automation and execute with evidence (see <code>rg:&lt;runId&gt;</code> on the Execution tab). Neither replaces the work-item Playwright prepare flow above.
            </Typography>
            <Alert severity="info" sx={{ mb: 2 }}>
              Start Regression from <Link to="/workflows">Workflows</Link> (Full / Selected / Smoke templates). After a run finishes, open{' '}
              {session.can('report.view') ? <Link to="/reports">Reports</Link> : 'Reports'} or{' '}
              {session.can('evidence.view') ? <Link to="/evidence">Evidence</Link> : 'Evidence'} for the readable summary and screenshots.
            </Alert>
            {runs.isError && <ErrorNotice message="Runs could not be loaded." onRetry={() => void runs.refetch()} />}
            {runs.data && items.length === 0 && <Alert severity="info">No workflow runs yet. Start one from a published workflow (including Regression).</Alert>}
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
            <HistoryRunDetail
              current={current}
              open={Boolean(open)}
              stepEvents={stepEvents}
              eventsError={events.isError}
              onRetryEvents={() => void events.refetch()}
              controlPending={control.isPending}
              controlError={control.isError}
              onControl={(command) => control.mutate(command)}
              canControl={session.can('execution.control')}
              canReport={session.can('report.view')}
              canEvidence={session.can('evidence.view')}
              evidenceExecutionId={findEvidenceExecutionId(events.data?.items)}
            />
          )}
        </Stack>
      )}
    </>
  );
}

function HistoryRunDetail({
  current,
  open,
  stepEvents,
  eventsError,
  onRetryEvents,
  controlPending,
  controlError,
  onControl,
  canControl,
  canReport,
  canEvidence,
  evidenceExecutionId,
}: {
  current: { id: string; workflowId: string; workflowName: string; status: string; stepIndex: number };
  open: boolean;
  stepEvents: Array<{ seq: number; kind: string; payload: Record<string, unknown> }>;
  eventsError: boolean;
  onRetryEvents: () => void;
  controlPending: boolean;
  controlError: boolean;
  onControl: (command: 'pause' | 'resume' | 'cancel') => void;
  canControl: boolean;
  canReport: boolean;
  canEvidence: boolean;
  evidenceExecutionId: string | null;
}) {
  return (
    <Paper component="section" sx={{ p: 2 }} aria-label="Selected run">
      <Typography variant="h2" gutterBottom>Step timeline</Typography>
      <Typography sx={{ mb: 2 }}>
        {current.workflowName} is {STATUS[current.status]?.toLowerCase() ?? current.status}, at step {current.stepIndex}.
      </Typography>
      {evidenceExecutionId && (canReport || canEvidence) && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 2, flexWrap: 'wrap' }}>
          {canReport && (
            <Link to="/runs/$id" params={{ id: evidenceExecutionId }} search={{ view: 'report', from: 'executions' } as never}>
              <Button variant="contained" size="small">Open report</Button>
            </Link>
          )}
          {canEvidence && (
            <Link to="/runs/$id" params={{ id: evidenceExecutionId }} search={{ view: 'evidence', from: 'executions' } as never}>
              <Button size="small">Open evidence</Button>
            </Link>
          )}
        </Stack>
      )}
      {canControl && open && (
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          {current.status === 'paused'
            ? <Button variant="contained" disabled={controlPending} onClick={() => onControl('resume')}>Resume</Button>
            : <Button disabled={controlPending} onClick={() => onControl('pause')}>Pause</Button>}
          <Button color="error" disabled={controlPending} onClick={() => onControl('cancel')}>Cancel</Button>
        </Stack>
      )}
      {controlError && <ErrorNotice message="That command was rejected." />}
      {eventsError && <ErrorNotice message="The step history could not be loaded." onRetry={onRetryEvents} />}
      {stepEvents.length === 0 && !eventsError && <Alert severity="info">This run has no recorded steps yet.</Alert>}
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
            const qualityRefuse = failed && /quality gate|stub-forbidden|Publish refused/i.test(output);
            const artifact = markdownFromStepPayload(event.payload);
            return (
              <Paper key={event.seq} variant="outlined" sx={{ p: 1.5 }}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Chip size="small" color={failed ? 'error' : 'success'} label={failed ? 'Failed' : 'Done'} />
                  <Typography sx={{ fontWeight: 600 }}>{label}</Typography>
                  <Typography variant="caption" color="text.secondary">#{event.seq}</Typography>
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
      )}
    </Paper>
  );
}
