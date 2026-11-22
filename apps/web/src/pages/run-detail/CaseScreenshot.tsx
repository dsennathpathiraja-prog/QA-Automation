import { Alert, Box, Typography } from '@mui/material';
import { WorkItemCaseScreenshot } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../api/context';

export function CaseScreenshot({
  executionId,
  testCaseId,
  name,
  maxHeight = 240,
}: {
  executionId: string;
  testCaseId: string;
  name: string;
  maxHeight?: number;
}) {
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
        maxHeight,
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
