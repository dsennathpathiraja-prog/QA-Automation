import {
  Alert,
  Box,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../api/context';
import { ErrorNotice, PageHeader } from './common';
import { countsLabel, type RunDetailView, WI_LIVE, WI_STATUS } from './run-detail/helpers';
import { WorkItemRunDetail } from './run-detail/WorkItemRunDetail';

export type ReportEvidenceMode = 'report' | 'evidence';

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

type ReportSearch = {
  focus?: string;
  view?: RunDetailView;
  case?: string;
};

/**
 * Product Report / Evidence surface for finished (and live) work-item / Regression runs.
 * Deep-link: `?focus=<executionId>&view=report|evidence&case=<testCaseId>`.
 *
 * Selection uses local state first (so Open report / Open evidence always open the detail),
 * then syncs the URL for shareable deep links.
 */
export function ReportEvidence({ mode }: { mode: ReportEvidenceMode }) {
  const api = useApi();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as ReportSearch;
  const focusFromUrl = typeof search.focus === 'string' && search.focus.trim() ? search.focus.trim() : null;
  const focusCase = typeof search.case === 'string' && search.case.trim() ? search.case.trim() : null;
  const viewFromUrl = search.view === 'summary' || search.view === 'report' || search.view === 'evidence'
    ? search.view
    : null;

  const [selectedId, setSelectedId] = useState<string | null>(focusFromUrl);
  const [view, setViewState] = useState<RunDetailView>(viewFromUrl ?? mode);
  const detailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (focusFromUrl) setSelectedId(focusFromUrl);
  }, [focusFromUrl]);

  useEffect(() => {
    if (viewFromUrl) setViewState(viewFromUrl);
  }, [viewFromUrl]);

  const board = useQuery({
    queryKey: ['work-item-executions'],
    queryFn: () => api.get('/api/v1/work-item-executions', WorkItemExecutionBoard),
    refetchInterval: (q) => (q.state.data?.items.some((item) => WI_LIVE.has(item.status)) ? 2000 : false),
  });

  const detail = useQuery({
    queryKey: ['work-item-execution', selectedId],
    queryFn: () => api.get(`/api/v1/work-item-executions/${selectedId}`, WorkItemExecutionSchema),
    enabled: Boolean(selectedId),
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

  const shown = detail.data
    ?? (selectedId ? board.data?.items.find((item) => item.id === selectedId) : undefined);

  useEffect(() => {
    if (!selectedId || !shown || !detailRef.current) return;
    // jsdom (unit tests) does not implement scrollIntoView.
    detailRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [selectedId, shown?.id, view]);

  const searchFor = (id: string, nextView: RunDetailView): ReportSearch => ({
    focus: id,
    ...(nextView !== mode ? { view: nextView } : {}),
    ...(focusCase ? { case: focusCase } : {}),
  });

  const openRun = (id: string, nextView: RunDetailView = mode) => {
    setSelectedId(id);
    setViewState(nextView);
    const path = mode === 'report' ? '/reports' : '/evidence';
    void navigate({
      to: path,
      search: () => searchFor(id, nextView) as never,
      replace: false,
    });
  };

  const setView = (next: RunDetailView) => {
    if (!selectedId) return;
    setViewState(next);
    const path = mode === 'report' ? '/reports' : '/evidence';
    void navigate({
      to: path,
      search: () => searchFor(selectedId, next) as never,
      replace: true,
    });
  };

  const title = mode === 'report' ? 'Reports' : 'Evidence';
  const description = mode === 'report'
    ? 'Readable pass/fail/blocked/skipped/not-automated summaries for finished Regression and work-item runs.'
    : 'Browse screenshots and attachments captured on case results for finished runs.';
  const openLabel = mode === 'report' ? 'Open report' : 'Open evidence';
  const listPath = mode === 'report' ? '/reports' : '/evidence';

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
                    selected={selectedId === item.id}
                    onClick={() => openRun(item.id, mode)}
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
                    component={Link}
                    to={listPath}
                    search={searchFor(item.id, mode) as never}
                    size="small"
                    variant={selectedId === item.id ? 'contained' : 'outlined'}
                    onClick={(e) => {
                      // Open immediately even if router search sync is slow / no-ops on same route.
                      e.preventDefault();
                      openRun(item.id, mode);
                    }}
                    sx={{ flexShrink: 0 }}
                  >
                    {openLabel}
                  </Button>
                </ListItem>
              ))}
            </List>
          )}
        </Paper>

        {selectedId && detail.isError && !shown && (
          <ErrorNotice message="That run could not be loaded." onRetry={() => void detail.refetch()} />
        )}
        {shown && (
          <Box ref={detailRef} tabIndex={-1}>
            <WorkItemRunDetail
              shown={shown}
              view={view}
              onViewChange={setView}
              focusCaseId={focusCase}
            />
          </Box>
        )}
        {selectedId && !shown && !detail.isError && detail.isLoading && (
          <Alert severity="info">Loading run detail…</Alert>
        )}
      </Stack>
    </>
  );
}
