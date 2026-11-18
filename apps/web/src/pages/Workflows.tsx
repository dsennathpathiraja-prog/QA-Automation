import { WorkflowListResponse, WorkflowSchema, WorkflowTemplateList } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

const key = ['workflows'] as const;
const TYPES = [
  { value: 'requirement-validation', label: 'Requirement validation' },
  { value: 'regression-testing', label: 'Regression testing' },
] as const;

export function Workflows() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: key, queryFn: () => api.get('/api/v1/workflows', WorkflowListResponse) });
  const templates = useQuery({ queryKey: ['workflow-templates'], queryFn: () => api.get('/api/v1/workflow-templates', WorkflowTemplateList), enabled: session.can('workflow.create') });
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]['value']>('requirement-validation');
  const [templateKey, setTemplateKey] = useState('');
  const add = useMutation({
    mutationFn: (body: { name: string; type: 'requirement-validation' | 'regression-testing'; templateKey?: string }) => api.post('/api/v1/workflows', body, WorkflowSchema),
    onSuccess: async (created) => {
      setName('');
      await qc.invalidateQueries({ queryKey: key });
      await navigate({ to: '/workflows/$id', params: { id: created.id } });
    },
  });
  const chosen = templates.data?.items.find((t) => t.key === templateKey);
  return (
    <>
      <PageHeader title="Workflows" description="Create a draft from a template, check it, and publish. The worker runs a published workflow." />
      <div className="space-y-4">
        {session.can('workflow.create') && (
          <Card label="New draft">
            <form onSubmit={(e) => { e.preventDefault(); add.mutate({ name, type: chosen?.type ?? type, ...(templateKey ? { templateKey } : {}) }); }}>
              <Field id="wf-name" label="Name"><input id="wf-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field id="wf-template" label="Template">
                <select id="wf-template" className={fieldClass} value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                  <option value="">Empty draft</option>
                  {templates.data?.items.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
                </select>
              </Field>
              {!chosen && (
                <Field id="wf-type" label="Type">
                  <select id="wf-type" className={fieldClass} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                    {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </Field>
              )}
              {chosen && <p className="mt-2">{chosen.summary}</p>}
              <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending}>Create draft</button>
              {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The draft could not be saved.')} /></div>}
            </form>
          </Card>
        )}
        <Card label="Workflows">
          {q.isError && <ErrorNotice message="Workflows could not be loaded." onRetry={() => void q.refetch()} />}
          {q.data && q.data.items.length === 0 && <p>No workflows yet.</p>}
          {q.data && q.data.items.length > 0 && (
            <ul>
              {q.data.items.map((w) => (
                <li key={w.id}>
                  <Link to="/workflows/$id" params={{ id: w.id }} className="text-blue-700 underline dark:text-blue-300">{w.name}</Link>
                  {' · '}{w.type === 'requirement-validation' ? 'Requirement validation' : 'Regression testing'} · {w.status}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
