import { Box, Button, Stack, Typography } from '@mui/material';
import { useState } from 'react';

/** Pull Markdown operators can verify from a step.completed payload.outputs. */
export function markdownFromStepPayload(payload: Record<string, unknown>): { markdown: string; path: string } | null {
  const outputs = payload.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return null;
  const out = outputs as Record<string, unknown>;
  const markdown = typeof out.artifactMarkdown === 'string' && out.artifactMarkdown.trim()
    ? out.artifactMarkdown
    : typeof out.planMarkdown === 'string' && out.planMarkdown.trim()
      ? out.planMarkdown
      : '';
  if (!markdown) return null;
  const path = typeof out.artifactPath === 'string' && out.artifactPath.trim()
    ? out.artifactPath
    : typeof out.planArtifact === 'string' && out.planArtifact.trim()
      ? out.planArtifact
      : 'artifact.md';
  return { markdown, path };
}

/** Expandable Markdown block for Run / History step output. */
export function StepArtifact({ markdown, path }: { markdown: string; path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Stack spacing={0.5} sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" color="text.secondary">Markdown artifact</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'ui-monospace, monospace' }}>{path}</Typography>
        <Button size="small" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</Button>
      </Stack>
      {open && (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            maxHeight: 360,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 12,
            bgcolor: 'action.hover',
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
          }}
        >
          {markdown}
        </Box>
      )}
    </Stack>
  );
}
