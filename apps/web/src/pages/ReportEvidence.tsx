import {
  Alert,
  Button,
  Chip,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { WorkItemExecutionBoard, WorkItemExecutionSchema } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useApi } from '../api/context';
import { ErrorNotice, PageHeader } from './common';
import { countsLabel, type RunDetailView, WI_LIVE, WI_STATUS } from './run-detail/helpers';
import { WorkItemRunDetail } from './run-detail/WorkItemRunDetail';

export type ReportEvidenceMode = 'report' | 'evidence';

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

/**
 * Product Report / Evidence surface for finished (and live) work-item / Regression runs.
 * Deep-link: `?focus=<executionId>&view=report|evidence&case=<testCaseId>`.
 */
export function ReportEvidence({ mode }: { mode: ReportEvidenceMode }) {
  const api = useApi();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as {
    focus?: string;
    view?: string;
    case?: string;
  };
  const focus = typeof search.focus === 'string' && search.focus.trim() ? search.focus.trim() : null;
  const focusCase = typeof search.case === 'string' && search.case.trim() ? search.case.trim() : null;
  const view: RunDetailView = search.view === 'summary' || search.view === 'report' || search.view === 'evidence'
    ? search.view
    : mode;

  const board = useQuery({
    queryKey: ['work-item-executions'],
    queryFn: () => api.get('/api/v1/work-item-executions', WorkItemExecutionBoard),
    refetchInterval: (q) => (q.state.data?.items.some((item) => WI_LIVE.has(item.status)) ? 2000 : false),
  });

  const detail = useQuery({
    queryKey: ['work-item-execution', focus],
    queryFn: () => api.get(`/api/v1/work-item-executions/${focus}`, WorkItemExecutionSchema),
    enabled: Boolean(focus),
    refetchInterval: (q) => (q.state.data && WI_LIVE.has(q.state.data.status) ? 1000 : false),
  });

  const runs = useMemo(() => {
    const items = board.data?.items ?? [];
    return items
      .filter((item) => item.status !== 'prepared')
      .slice()
      .sort((a, b) => {
        const aFin = FINISHED.has(a.status) ? 0 : 1;
        const bFin = FINISHED.has(b.status) ? 0 : 1;
        if (aFin !== bFin) return aFin - bFin;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      })
      .slice(0, 40);
  }, [board.data?.items]);

  const shown = detail.data ?? board.data?.items.find((item) => item.id === focus);

  const setFocus = (id: string, nextView: RunDetailView = view) => {
    void navigate({
      to: mode === 'report' ? '/reports' : '/evidence',
      search: {
        focus: id,
        ...(nextView !== mode ? { view: nextView } : {}),
        ...(focusCase ? { case: focusCase } : {}),
      } as never,
    });
  };

  const setView = (next: RunDetailView) => {
    if (!focus) return;
    void navigate({
      to: mode === 'report' ? '/reports' : '/evidence',
      search: {
        focus,
        ...(next !== mode ? { view: next } : {}),
        ...(focusCase ? { case: focusCase } : {}),
      } as never,
    });
  };

  const title = mode === 'report' ? 'Reports' : 'Evidence';
  const description = mode === 'report'
    ? 'Readable pass/fail/blocked/skipped/not-automated summaries for finished Regression and work-item runs.'
    : 'Browse screenshots and attachments captured on case results for finished runs.';

  return (
    <>
      <PageHeader title={title} description={description} />
      <Stack spacing={2}>
        <Paper component="section" sx={{ p: 2 }} aria-label={mode === 'report' ? 'Runs with reports' : 'Runs with evidence'}>
          <Typography variant="h2" gutterBottom>
            {mode === 'report' ? 'Finished runs' : 'Runs with evidence'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Regression evidence rows are labeled <code>rg:&lt;runId&gt;</code>. Start Regression from{' '}
            <Link to="/workflows">Workflows</Link>; live progress also appears on{' '}
            <Link to="/executions">Executions</Link>.
          </Typography>
          {board.isError && (
            <ErrorNotice message="Runs could not be loaded." onRetry={() => void board.refetch()} />
          )}
          {board.data && runs.length === 0 && (
            <Alert severity="info">
              No work-item or Regression evidence runs yet. Prepare a work-item run on Executions, or finish a Regression workflow.
            </Alert>
          )}
          {runs.length > 0 && (
            <List dense>
              {runs.map((item) => (
                <ListItem
                  key={item.id}
                  disablePadding
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5 }}
                >
                  <ListItemButton
                    selected={focus === item.id}
                    onClick={() => setFocus(item.id)}
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
                  <Button
                    size="small"
                    variant={focus === item.id ? 'contained' : 'outlined'}
                    onClick={() => setFocus(item.id, mode)}
                    sx={{ flexShrink: 0 }}
                  >
                    {mode === 'report' ? 'Open report' : 'Open evidence'}
                  </Button>
                </ListItem>
              ))}
            </List>
          )}
        </Paper>

        {focus && detail.isError && !shown && (
          <ErrorNotice message="That run could not be loaded." onRetry={() => void detail.refetch()} />
        )}
        {shown && (
          <WorkItemRunDetail
            shown={shown}
            view={view}
            onViewChange={setView}
            focusCaseId={focusCase}
          />
        )}
        {focus && !shown && !detail.isError && detail.isLoading && (
          <Alert severity="info">Loading run detail…</Alert>
        )}
      </Stack>
    </>
  );
}
