import {
  Alert,
  Box,
  Button,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { WorkflowListResponse, WorkflowSchema, WorkflowTemplateList } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { useProject } from '../project/ProjectContext';
import { ErrorNotice, PageHeader } from './common';
import { errorText } from './connectors/shared';

const TYPES = [
  { value: 'requirement-validation', label: 'Requirement validation' },
  { value: 'regression-testing', label: 'Regression testing' },
] as const;

type ListTab = 'list' | 'create';

export function Workflows() {
  const api = useApi();
  const session = useSession();
  const { selected, selectedId } = useProject();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<ListTab>('list');
  const key = ['workflows', selectedId] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get(`/api/v1/workflows?projectId=${encodeURIComponent(selectedId!)}`, WorkflowListResponse),
    enabled: !!selectedId,
  });
  const templates = useQuery({ queryKey: ['workflow-templates'], queryFn: () => api.get('/api/v1/workflow-templates', WorkflowTemplateList), enabled: session.can('workflow.create') });
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('requirement-validation');
  const [templateKey, setTemplateKey] = useState('');
  const add = useMutation({
    mutationFn: (body: { projectId: string; name: string; type: 'requirement-validation' | 'regression-testing'; templateKey?: string }) =>
      api.post('/api/v1/workflows', body, WorkflowSchema),
    onSuccess: async (created) => {
      setName('');
      await qc.invalidateQueries({ queryKey: key });
      await navigate({ to: '/workflows/$id', params: { id: created.id } });
    },
  });
  const chosen = templates.data?.items.find((t) => t.key === templateKey);
  const published = (q.data?.items ?? []).filter((w) => w.status === 'published');
  return (
    <>
      <PageHeader
        title="Workflows"
        description={selected
          ? `Create a draft from a template, bind this project's connectors, then publish and run for ${selected.name}.`
          : 'Create a draft from a template, check it, and publish. The worker runs a published workflow.'}
      />
      <Paper sx={{ mb: 2 }}>
        <Tabs value={tab} onChange={(_, value: ListTab) => setTab(value)} aria-label="Workflows sections">
          <Tab value="list" label="My workflows" />
          {session.can('workflow.create') && <Tab value="create" label="New draft" />}
        </Tabs>
      </Paper>

      {tab === 'list' && (
        <Paper sx={{ p: 2 }} aria-label="Workflows">
          <Typography variant="h2" gutterBottom>My workflows</Typography>
          {q.isError && <ErrorNotice message="Workflows could not be loaded." onRetry={() => void q.refetch()} />}
          {q.data && q.data.items.length === 0 && <Alert severity="info">No workflows in this project yet. New projects start empty — create a draft from a template.</Alert>}
          {q.data && q.data.items.length > 0 && (
            <List>
              {q.data.items.map((w) => (
                <Link key={w.id} to="/workflows/$id" params={{ id: w.id }} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <ListItemButton>
                    <ListItemText
                      primary={w.name}
                      secondary={`${w.type === 'requirement-validation' ? 'Requirement validation' : 'Regression testing'} · ${w.status}`}
                    />
                  </ListItemButton>
                </Link>
              ))}
            </List>
          )}
          {published.length > 0 && (
            <Alert severity="success" sx={{ mt: 2 }}>
              {published.length} published workflow{published.length === 1 ? '' : 's'} ready to run for this project. Open one and use Run &amp; output.
            </Alert>
          )}
        </Paper>
      )}

      {tab === 'create' && session.can('workflow.create') && selectedId && (
        <Paper sx={{ p: 2 }} aria-label="New draft">
          <Typography variant="h2" gutterBottom>New draft</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Pick a template for steps and connector roles. Bind this project's connectors on the draft's Connectors tab before you publish — there is no connector picker on create.
          </Typography>
          <Stack
            component="form"
            spacing={2}
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate({ projectId: selectedId, name, type: chosen?.type ?? type, ...(templateKey ? { templateKey } : {}) });
            }}
          >
            <TextField id="wf-name" label="Name" required value={name} onChange={(e) => setName(e.target.value)} fullWidth />
            <FormControl fullWidth>
              <InputLabel id="wf-template-label">Template</InputLabel>
              <Select
                labelId="wf-template-label"
                id="wf-template"
                label="Template"
                value={templateKey}
                onChange={(e) => setTemplateKey(String(e.target.value))}
              >
                <MenuItem value="">Empty draft</MenuItem>
                {templates.data?.items.map((t) => <MenuItem key={t.key} value={t.key}>{t.name}</MenuItem>)}
              </Select>
            </FormControl>
            {!chosen && (
              <FormControl fullWidth>
                <InputLabel id="wf-type-label">Type</InputLabel>
                <Select
                  labelId="wf-type-label"
                  id="wf-type"
                  label="Type"
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  {TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
                </Select>
              </FormControl>
            )}
            {chosen && <Alert severity="info">{chosen.summary}</Alert>}
            <Box>
              <Button type="submit" variant="contained" disabled={add.isPending}>Create draft</Button>
            </Box>
            {add.isError && <ErrorNotice message={errorText(add.error, 'The draft could not be saved.')} />}
          </Stack>
        </Paper>
      )}
    </>
  );
}
