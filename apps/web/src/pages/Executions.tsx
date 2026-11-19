import { ExecutionEventList, ExecutionListResponse, ExecutionSchema, WorkItemExecutionBoard, WorkItemExecutionSchema } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, buttonClass, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

const key = ['executions'] as const;
const LIVE = new Set(['queued', 'running']);
const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function Executions() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [workItem, setWorkItem] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const board = useQuery({ queryKey: ['work-item-executions'], queryFn: () => api.get('/api/v1/work-item-executions', WorkItemExecutionBoard) });
  const prepare = useMutation({
    mutationFn: () => api.post('/api/v1/work-item-executions', { workItem, environmentId }, WorkItemExecutionSchema),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['work-item-executions'] }); },
  });
  const runs = useQuery({
    queryKey: key,
    queryFn: () => api.get('/api/v1/executions', ExecutionListResponse),
    refetchInterval: (q) => (q.state.data?.items.some((item) => LIVE.has(item.status)) ? 2000 : false),
  });
  const events = useQuery({
    queryKey: ['execution', selected, 'events'],
    queryFn: () => api.get(`/api/v1/executions/${selected}/events`, ExecutionEventList),
    enabled: Boolean(selected),
    refetchInterval: () => {
      const status = runs.data?.items.find((item) => item.id === selected)?.status;
      return status === 'queued' || status === 'running' ? 1000 : false;
    },
  });
  const control = useMutation({
    mutationFn: (command: 'pause' | 'resume' | 'cancel') => api.post(`/api/v1/executions/${selected}/${command}`, {}, ExecutionSchema),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
      await qc.invalidateQueries({ queryKey: ['execution', selected, 'events'] });
    },
  });
  const items = runs.data?.items ?? [];
  const current = items.find((item) => item.id === selected);
  const open = current && current.status !== 'succeeded' && current.status !== 'failed' && current.status !== 'cancelled';
  return (
    <>
      <PageHeader title="Executions" description="Run the test cases of one work item. The environment is chosen here." />
      <div className="space-y-4">
        <Card label="Work item">
          {board.isError && <ErrorNotice message="Work item executions could not be loaded." onRetry={() => void board.refetch()} />}
          {board.data && board.data.workItems.length === 0 && <p>No work item has test cases yet. A requirement-validation run stores them first.</p>}
          {board.data && board.data.workItems.length > 0 && (
            <form onSubmit={(e) => { e.preventDefault(); prepare.mutate(); }}>
              <Field id="exec-work-item" label="Work item">
                <select id="exec-work-item" required className={fieldClass} value={workItem} onChange={(e) => setWorkItem(e.target.value)}>
                  <option value="">Choose a work item</option>
                  {board.data.workItems.map((item) => <option key={item.workItem} value={item.workItem}>{item.workItem} · {item.caseCount} {item.caseCount === 1 ? 'case' : 'cases'}</option>)}
                </select>
              </Field>
              <Field id="exec-environment" label="Environment">
                <select id="exec-environment" required className={fieldClass} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                  <option value="">Choose an environment</option>
                  {board.data.environments.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}
                </select>
              </Field>
              {board.data.environments.length === 0 && <p className="mt-3">No environment can be selected yet.</p>}
              <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={prepare.isPending || board.data.environments.length === 0}>Prepare execution</button>
              {prepare.isError && <div className="mt-3"><ErrorNotice message={errorText(prepare.error, 'The execution could not be prepared.')} /></div>}
            </form>
          )}
          {board.data && board.data.items.length > 0 && (
            <ul className="mt-4 space-y-2">
              {board.data.items.map((item) => (
                <li key={item.id}>{item.workItem} · {item.environmentName} · {item.caseCount} {item.caseCount === 1 ? 'case' : 'cases'} · Not run yet. The runner has not executed these cases.</li>
              ))}
            </ul>
          )}
        </Card>
        <Card label="Workflow runs">
          <p className="mb-3">These runs create the test cases. They are not the execution of a work item.</p>
          {runs.isError && <ErrorNotice message="Runs could not be loaded." onRetry={() => void runs.refetch()} />}
          {runs.data && items.length === 0 && <p>No workflow runs yet. Start one from a published workflow.</p>}
          {items.length > 0 && (
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.id}>
                  <button type="button" className="text-left text-blue-700 underline dark:text-blue-300" onClick={() => setSelected(item.id)}>
                    {item.workflowName}
                  </button>
                  {' · '}{STATUS[item.status] ?? item.status} · step {item.stepIndex} · {item.id.slice(0, 8)}
                  {' · '}
                  <Link to="/workflows/$id" params={{ id: item.workflowId }} className="text-blue-700 underline dark:text-blue-300">Workflow</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {current && (
          <Card label="Selected run">
            <p>{current.workflowName} is {STATUS[current.status]?.toLowerCase() ?? current.status}, at step {current.stepIndex}.</p>
            {session.can('execution.control') && open && (
              <div className="mt-3 flex flex-wrap gap-2">
                {current.status === 'paused'
                  ? <button type="button" className={buttonClass} disabled={control.isPending} onClick={() => control.mutate('resume')}>Resume</button>
                  : <button type="button" className={buttonClass} disabled={control.isPending} onClick={() => control.mutate('pause')}>Pause</button>}
                <button type="button" className={buttonClass} disabled={control.isPending} onClick={() => control.mutate('cancel')}>Cancel</button>
              </div>
            )}
            {control.isError && <div className="mt-3"><ErrorNotice message={errorText(control.error, 'That command was rejected.')} /></div>}
            {events.isError && <div className="mt-3"><ErrorNotice message="The step history could not be loaded." onRetry={() => void events.refetch()} /></div>}
            {events.data && (
              <ul className="mt-3 space-y-2">
                {events.data.items.filter((event) => event.kind === 'step.completed' || event.kind === 'step.failed').map((event) => (
                  <li key={event.seq}>{event.kind === 'step.failed' ? 'Failed' : 'Done'}. {typeof event.payload.summary === 'string' && event.payload.summary ? event.payload.summary : String(event.payload.stepId ?? event.kind)}</li>
                ))}
                {events.data.items.every((event) => event.kind !== 'step.completed' && event.kind !== 'step.failed') && <li>This run has no recorded steps yet.</li>}
              </ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
