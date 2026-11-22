import {
  Alert,
  Box,
  Chip,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { CaseScreenshot } from './CaseScreenshot';
import { CASE_CHIP, screenshotEmptyHint, type WorkItemRun } from './helpers';

export function RunEvidencePanel({
  shown,
  focusCaseId,
}: {
  shown: WorkItemRun;
  focusCaseId?: string | null;
}) {
  const withShots = useMemo(
    () => (shown.results ?? []).filter((row) => row.hasScreenshot && row.status !== 'Queued' && row.status !== 'Running'),
    [shown.results],
  );
  const withoutShots = useMemo(
    () => (shown.results ?? []).filter((row) => !row.hasScreenshot && row.status !== 'Queued' && row.status !== 'Running'),
    [shown.results],
  );
  const [selected, setSelected] = useState<string | null>(
    focusCaseId && withShots.some((r) => r.testCaseId === focusCaseId)
      ? focusCaseId
      : withShots[0]?.testCaseId ?? null,
  );
  const active = withShots.find((row) => row.testCaseId === selected) ?? withShots[0];

  if (!shown.results || shown.results.length === 0) {
    return (
      <Alert severity="info" aria-label="No evidence yet">
        {shown.status === 'queued' || shown.status === 'running'
          ? 'Evidence appears as cases finish and Playwright captures screenshots.'
          : 'This run has no case results to show as evidence.'}
      </Alert>
    );
  }

  return (
    <Stack component="section" spacing={2} aria-label="Run evidence">
      <Typography variant="body2" color="text.secondary">
        {withShots.length} screenshot{withShots.length === 1 ? '' : 's'} captured
        {withoutShots.length > 0 ? ` · ${withoutShots.length} without screenshot` : ''}.
      </Typography>

      {withShots.length === 0 ? (
        <Alert severity="info">
          No screenshots were stored for this run. Case messages below explain why when the runner was unavailable.
        </Alert>
      ) : (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} useFlexGap sx={{ alignItems: 'stretch' }}>
          <Paper variant="outlined" sx={{ flex: '0 1 280px', minWidth: 0 }} aria-label="Cases with screenshots">
            <List dense>
              {withShots.map((row) => (
                <ListItem key={row.id} disablePadding>
                  <ListItemButton
                    selected={active?.testCaseId === row.testCaseId}
                    onClick={() => setSelected(row.testCaseId)}
                  >
                    <ListItemText
                      primary={row.name}
                      secondary={row.status}
                      slotProps={{ primary: { noWrap: true } }}
                    />
                    <Chip size="small" label={row.status} color={CASE_CHIP[row.status] ?? 'default'} sx={{ ml: 1 }} />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </Paper>
          <Paper variant="outlined" sx={{ flex: '1 1 320px', p: 2, minWidth: 0 }} aria-label="Selected screenshot">
            {active ? (
              <>
                <Typography sx={{ fontWeight: 600 }} gutterBottom>{active.name}</Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ mb: 1, flexWrap: 'wrap' }}>
                  <Chip size="small" label={active.status} color={CASE_CHIP[active.status] ?? 'default'} />
                  {active.squashExecutionId && (
                    <Chip size="small" variant="outlined" label={`Squash ${active.squashExecutionId}`} />
                  )}
                </Stack>
                {active.message && (
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{active.message}</Typography>
                )}
                <CaseScreenshot
                  executionId={shown.id}
                  testCaseId={active.testCaseId}
                  name={active.name}
                  maxHeight={420}
                />
              </>
            ) : (
              <Alert severity="info">Select a case to browse its screenshot.</Alert>
            )}
          </Paper>
        </Stack>
      )}

      {withoutShots.length > 0 && (
        <Paper variant="outlined" sx={{ p: 2 }} aria-label="Cases without screenshots">
          <Typography variant="h2" gutterBottom>Without screenshots</Typography>
          <Stack spacing={1}>
            {withoutShots.map((row) => (
              <Box key={row.id}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography sx={{ fontWeight: 600 }}>{row.name}</Typography>
                  <Chip size="small" label={row.status} color={CASE_CHIP[row.status] ?? 'default'} />
                </Stack>
                <Alert sx={{ mt: 0.5 }} severity="info" aria-label={`No screenshot for ${row.name}`}>
                  {screenshotEmptyHint(row.message)}
                </Alert>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
