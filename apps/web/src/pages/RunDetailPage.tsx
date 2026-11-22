import { Alert, Button, Stack, Typography } from '@mui/material';
import { WorkItemExecutionSchema } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { AccessDenied, ErrorNotice, PageHeader } from './common';
import { parseRunDetailView, type RunDetailView, WI_LIVE } from './run-detail/helpers';
import { WorkItemRunDetail } from './run-detail/WorkItemRunDetail';

type RunSearch = {
  view?: RunDetailView;
  case?: string;
  from?: 'reports' | 'evidence' | 'executions';
};

/**
 * Dedicated run detail page — Report / Evidence / Summary for one work-item execution.
 * Route: `/runs/$id?view=report|evidence|summary&case=<testCaseId>&from=reports|evidence`
 */
export function RunDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const session = useSession();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as RunSearch;
  const canView = session.can('report.view') || session.can('evidence.view') || session.can('execution.start');

  const view = parseRunDetailView(
    search.view === 'summary' || search.view === 'report' || search.view === 'evidence'
      ? search.view
      : 'report',
  );
  const focusCase = typeof search.case === 'string' && search.case.trim() ? search.case.trim() : null;
  const from = search.from === 'evidence' || search.from === 'executions' ? search.from : 'reports';

  const detail = useQuery({
    queryKey: ['work-item-execution', id],
    queryFn: () => api.get(`/api/v1/work-item-executions/${id}`, WorkItemExecutionSchema),
    enabled: Boolean(id) && canView,
    refetchInterval: (q) => (q.state.data && WI_LIVE.has(q.state.data.status) ? 1000 : false),
  });

  const setView = (next: RunDetailView) => {
    const caseQ = focusCase ? `&case=${encodeURIComponent(focusCase)}` : '';
    void navigate({
      to: `/runs/${id}?view=${next}&from=${from}${caseQ}`,
      replace: true,
    } as never);
  };

  if (!canView) return <AccessDenied title="Run detail" />;

  const backTo = from === 'evidence' ? '/evidence' : from === 'executions' ? '/executions' : '/reports';
  const backLabel = from === 'evidence' ? 'Evidence' : from === 'executions' ? 'Executions' : 'Reports';

  return (
    <>
      <PageHeader
        title="Run detail"
        description={detail.data
          ? `${detail.data.workItem} on ${detail.data.environmentName}`
          : 'Report, evidence, and case results for this run.'}
      />
      <Typography sx={{ mb: 2 }}>
        <Link to={backTo}>{`← Back to ${backLabel}`}</Link>
      </Typography>

      {detail.isError && (
        <ErrorNotice message="That run could not be loaded." onRetry={() => void detail.refetch()} />
      )}
      {detail.isLoading && !detail.data && <Alert severity="info">Loading run detail…</Alert>}
      {detail.data && (
        <Stack spacing={2}>
          <WorkItemRunDetail
            shown={detail.data}
            view={view}
            onViewChange={setView}
            focusCaseId={focusCase}
          />
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {session.can('report.view') && view !== 'report' && (
              <Button size="small" variant="outlined" onClick={() => setView('report')}>Show report</Button>
            )}
            {session.can('evidence.view') && view !== 'evidence' && (
              <Button size="small" variant="outlined" onClick={() => setView('evidence')}>Show evidence</Button>
            )}
          </Stack>
        </Stack>
      )}
    </>
  );
}
