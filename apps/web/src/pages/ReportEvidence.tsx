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
import { WorkItemExecutionBoard } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo } from 'react';
import { useApi } from '../api/context';
import { useProject } from '../project/ProjectContext';
import { ErrorNotice, PageHeader } from './common';
import { countsLabel, type RunDetailView, WI_LIVE, WI_STATUS } from './run-detail/helpers';

export type ReportEvidenceMode = 'report' | 'evidence';

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

type LegacySearch = {
  focus?: string;
  view?: string;
  case?: string;
};

/**
 * Reports / Evidence list. Opening a run navigates to the dedicated `/runs/$id` page.
 * Legacy `?focus=` deep links redirect to `/runs/$id`.
 */
export function ReportEvidence({ mode }: { mode: ReportEvidenceMode }) {
  const api = useApi();
  const { selectedId } = useProject();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as LegacySearch;
  const focusFromUrl = typeof search.focus === 'string' && search.focus.trim() ? search.focus.trim() : null;

  // Back-compat: old `/reports?focus=` / `/evidence?focus=` → dedicated run page.
  useEffect(() => {
    if (!focusFromUrl) return;
    const view: RunDetailView = search.view === 'summary' || search.view === 'report' || search.view === 'evidence'
      ? search.view
      : mode;
    const from = mode === 'report' ? 'reports' : 'evidence';
    const caseQ = typeof search.case === 'string' && search.case.trim()
      ? `&case=${encodeURIComponent(search.case.trim())}`
      : '';
    void navigate({
      to: `/runs/${focusFromUrl}?view=${view}&from=${from}${caseQ}`,
      replace: true,
    } as never);
  }, [focusFromUrl, mode, navigate, search.case, search.view]);

  const board = useQuery({
    queryKey: ['work-item-executions', selectedId],
    queryFn: () => api.get(`/api/v1/work-item-executions?projectId=${encodeURIComponent(selectedId!)}`, WorkItemExecutionBoard),
    enabled: Boolean(selectedId),
    refetchInterval: (q) => (q.state.data?.items.some((item) => WI_LIVE.has(item.status)) ? 2000 : false),
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

  const openRun = (id: string) => {
    const from = mode === 'report' ? 'reports' : 'evidence';
    void navigate({
      to: `/runs/${id}?view=${mode}&from=${from}`,
    } as never);
  };

  const title = mode === 'report' ? 'Reports' : 'Evidence';
  const description = mode === 'report'
    ? 'Readable pass/fail/blocked/skipped/not-automated summaries for finished Regression and work-item runs.'
    : 'Browse screenshots and attachments captured on case results for finished runs.';
  const openLabel = mode === 'report' ? 'Open report' : 'Open evidence';

  if (focusFromUrl) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <Alert severity="info">Opening run detail…</Alert>
      </>
    );
  }

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
            <Link to="/executions">Executions</Link>. Each run opens on its own detail page.
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
                    onClick={() => openRun(item.id)}
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
                    variant="outlined"
                    sx={{ flexShrink: 0 }}
                    onClick={() => openRun(item.id)}
                  >
                    {openLabel}
                  </Button>
                </ListItem>
              ))}
            </List>
          )}
        </Paper>
      </Stack>
    </>
  );
}
