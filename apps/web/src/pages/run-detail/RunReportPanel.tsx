import { Alert, Chip, Paper, Stack, Typography } from '@mui/material';
import { ExecutionEventList } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { ErrorNotice } from '../common';
import { StepArtifact } from '../StepArtifact';
import { findRegressionReport, talliesFromCaseResults, workflowRunIdFromWorkItem, type WorkItemRun } from './helpers';

export function RunReportPanel({ shown }: { shown: WorkItemRun }) {
  const api = useApi();
  const workflowRunId = workflowRunIdFromWorkItem(shown.workItem);
  const events = useQuery({
    queryKey: ['execution', workflowRunId, 'events', 'report'],
    queryFn: () => api.get(`/api/v1/executions/${workflowRunId}/events`, ExecutionEventList),
    enabled: Boolean(workflowRunId),
  });
  const artifact = findRegressionReport(events.data?.items);
  const tallies = artifact?.tallies ?? talliesFromCaseResults(shown.results);
  const finished = shown.status === 'completed' || shown.status === 'failed' || shown.status === 'cancelled';

  return (
    <Stack component="section" spacing={2} aria-label="Run report">
      {!finished && (
        <Alert severity="info">
          This run is still {shown.status}. Tallies update as cases finish; the full regression-report.md appears after the Regression report step.
        </Alert>
      )}
      <Paper variant="outlined" sx={{ p: 2 }} aria-label="Report tallies">
        <Typography variant="h2" gutterBottom>Summary</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {shown.workItem} on {shown.environmentName}
          {shown.finishedAt ? ` · finished ${new Date(shown.finishedAt).toLocaleString()}` : ''}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Chip size="small" color="success" label={`${tallies.passed} passed`} />
          <Chip size="small" color="error" label={`${tallies.failed} failed`} />
          <Chip size="small" color="warning" label={`${tallies.blocked} blocked`} />
          <Chip size="small" label={`${tallies.skipped} skipped`} />
          <Chip size="small" variant="outlined" label={`${tallies.notAutomated} not automated`} />
        </Stack>
        {(artifact?.syncSummary || shown.squashSync) && (
          <Alert sx={{ mt: 2 }} severity="info" aria-label="Squash sync line">
            {artifact?.syncSummary ?? shown.squashSync}
          </Alert>
        )}
      </Paper>

      {workflowRunId && events.isError && (
        <ErrorNotice message="The Regression report artifact could not be loaded from workflow events." onRetry={() => void events.refetch()} />
      )}
      {workflowRunId && events.isSuccess && !artifact && finished && (
        <Alert severity="info">
          No regression-report.md on this workflow run yet. Open Evidence for case screenshots, or wait until the Regression report step finishes.
        </Alert>
      )}
      {artifact && (
        <Paper variant="outlined" sx={{ p: 2 }} aria-label="Regression report markdown">
          <Typography variant="h2" gutterBottom>regression-report.md</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Readable summary from the Regression report step (pass / fail / blocked / skipped / not automated).
          </Typography>
          <StepArtifact markdown={artifact.markdown} path={artifact.path} defaultOpen />
        </Paper>
      )}
      {!workflowRunId && finished && (
        <Alert severity="info">
          Work-item Playwright runs show tallies and Evidence screenshots here. Full regression-report.md is produced by Regression workflows (`rg:&lt;runId&gt;`).
        </Alert>
      )}
    </Stack>
  );
}
