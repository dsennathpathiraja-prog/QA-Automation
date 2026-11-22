import {
  Alert,
  Box,
  Button,
  Chip,
  List,
  ListItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { CaseScreenshot } from './CaseScreenshot';
import {
  CASE_CHIP,
  parseRunDetailView,
  screenshotEmptyHint,
  squashSyncAlertSeverity,
  type RunDetailView,
  type WorkItemRun,
  WI_LIVE,
  WI_STATUS,
} from './helpers';
import { RunEvidencePanel } from './RunEvidencePanel';
import { RunReportPanel } from './RunReportPanel';

export function WorkItemRunDetail({
  shown,
  view = 'summary',
  onViewChange,
  focusCaseId,
  onCancel,
  cancelPending,
}: {
  shown: WorkItemRun;
  view?: RunDetailView | string;
  onViewChange?: (next: RunDetailView) => void;
  focusCaseId?: string | null;
  onCancel?: () => void;
  cancelPending?: boolean;
}) {
  const live = WI_LIVE.has(shown.status);
  const activeView = parseRunDetailView(view);
  const setView = (next: RunDetailView) => onViewChange?.(next);

  return (
    <Paper sx={{ p: 2 }} aria-label="Work item run">
      <Typography variant="h2" gutterBottom>{live ? 'Live run' : 'Run detail'}</Typography>
      <Typography>
        {shown.workItem} on {shown.environmentName} is {WI_STATUS[shown.status]?.toLowerCase() ?? shown.status}.
      </Typography>
      {onCancel && (
        <Box sx={{ mt: 2 }}>
          <Button color="error" disabled={cancelPending} onClick={onCancel}>Cancel run</Button>
        </Box>
      )}
      {shown.counts && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 2, flexWrap: 'wrap' }} aria-label="Run counts">
          <Chip size="small" label={`${shown.counts.completed}/${shown.counts.total} completed`} />
          <Chip size="small" color="success" label={`${shown.counts.passed} passed`} />
          <Chip size="small" color="error" label={`${shown.counts.failed} failed`} />
          {shown.counts.blocked > 0 && <Chip size="small" color="warning" label={`${shown.counts.blocked} blocked`} />}
          {shown.counts.skipped > 0 && <Chip size="small" label={`${shown.counts.skipped} skipped`} />}
          {shown.counts.running > 0 && <Chip size="small" color="info" label={`${shown.counts.running} running`} />}
          {shown.counts.queued > 0 && <Chip size="small" label={`${shown.counts.queued} queued`} />}
        </Stack>
      )}
      {live && (
        <Alert sx={{ mt: 2 }} severity="info">
          Updating every second while cases run. Per-case status, step progress, and pass/fail counts refresh as the runner reports them.
        </Alert>
      )}
      {shown.squashSync && (
        <Alert sx={{ mt: 2 }} severity={squashSyncAlertSeverity(shown.squashSync)} aria-label="Squash sync status">
          {shown.squashSync}
        </Alert>
      )}

      <Tabs
        value={activeView}
        onChange={(_, value: RunDetailView) => setView(value)}
        sx={{ mt: 2, borderBottom: 1, borderColor: 'divider' }}
        aria-label="Run detail sections"
      >
        <Tab value="summary" label="Summary" id="run-tab-summary" aria-controls="run-panel-summary" />
        <Tab value="report" label="Report" id="run-tab-report" aria-controls="run-panel-report" />
        <Tab value="evidence" label="Evidence" id="run-tab-evidence" aria-controls="run-panel-evidence" />
      </Tabs>

      <Box sx={{ pt: 2 }}>
        {activeView === 'summary' && (
          <Box id="run-panel-summary" role="tabpanel" aria-labelledby="run-tab-summary">
            {shown.results && shown.results.length > 0 ? (
              <List>
                {shown.results.map((row) => (
                  <ListItem key={row.id} alignItems="flex-start" sx={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Typography sx={{ fontWeight: 600 }}>{row.name}</Typography>
                      <Chip size="small" label={row.status} color={CASE_CHIP[row.status] ?? 'default'} />
                      {row.squashExecutionId && <Chip size="small" variant="outlined" label={`Squash ${row.squashExecutionId}`} />}
                      {row.hasScreenshot && <Chip size="small" variant="outlined" label="Screenshot" />}
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
            ) : shown.status === 'queued' ? (
              <Alert sx={{ mt: 1 }} severity="info">Queued. Case placeholders appear when the worker claims this run.</Alert>
            ) : (
              <Alert sx={{ mt: 1 }} severity="info">No case results yet. Open Report or Evidence after the run finishes.</Alert>
            )}
            {!live && shown.results && shown.results.length > 0 && (
              <Stack direction="row" spacing={1} useFlexGap sx={{ mt: 2, flexWrap: 'wrap' }}>
                <Button size="small" variant="outlined" onClick={() => setView('report')}>Open report</Button>
                <Button size="small" variant="outlined" onClick={() => setView('evidence')}>Browse evidence</Button>
              </Stack>
            )}
          </Box>
        )}
        {activeView === 'report' && (
          <Box id="run-panel-report" role="tabpanel" aria-labelledby="run-tab-report">
            <RunReportPanel shown={shown} />
          </Box>
        )}
        {activeView === 'evidence' && (
          <Box id="run-panel-evidence" role="tabpanel" aria-labelledby="run-tab-evidence">
            <RunEvidencePanel shown={shown} focusCaseId={focusCaseId} />
          </Box>
        )}
      </Box>
    </Paper>
  );
}
