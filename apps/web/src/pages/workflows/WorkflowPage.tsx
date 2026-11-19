import { ConnectorListResponse, ExecutionEventList, ExecutionListResponse, ExecutionSchema, ValidationReportSchema, WorkflowDefinitionResponse, WorkflowSchema } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useSession } from '../../auth/session';
import { Card, ErrorNotice, PageHeader } from '../common';
import { Field, buttonClass, errorText, fieldClass, primaryButtonClass } from '../connectors/shared';

interface Step { id: string; type: string; enabled?: boolean; mandatory?: boolean; locked?: boolean | string[]; dependsOn?: string[] }
interface ConnectorRow { role: string; category: string; binding?: { connectorInstanceId: string | null } }
interface Param { name: string; type: string; required: boolean; pinned?: unknown }
interface Def { spec?: { steps?: Step[]; connectors?: ConnectorRow[]; parameters?: Param[]; approvals?: { id: string; when: string }[]; execution?: { maxParallelism?: number; timeoutMinutes?: number } } }

const keyOf = (id: string) => ['workflow', id] as const;
const ROLE_LABEL: Record<string, string> = {
  workItemSource: 'Work items',
  browserAutomation: 'Browser',
  sourceRepo: 'Source repository',
  testManagement: 'Squash',
  testRunner: 'Test runner',
};

export function WorkflowPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const workflow = useQuery({ queryKey: keyOf(id), queryFn: () => api.get(`/api/v1/workflows/${id}`, WorkflowSchema) });
  const definition = useQuery({ queryKey: [...keyOf(id), 'definition'], queryFn: () => api.get(`/api/v1/workflows/${id}/definition`, WorkflowDefinitionResponse) });
  const [edited, setEdited] = useState<Def | null>(null);
  const [tab, setTab] = useState<'steps' | 'flow' | 'connectors' | 'check' | 'run'>('steps');
  const [params, setParams] = useState<Record<string, string>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const savedConnectors = useQuery({ queryKey: ['connectors'], queryFn: () => api.get('/api/v1/connectors', ConnectorListResponse), enabled: session.can('connector.view_status') });
  const def = edited ?? (definition.data?.definition as Def | undefined);
  const draft = workflow.data?.status === 'draft';
  const canEdit = draft && session.can('workflow.edit');
  const refresh = async () => { setEdited(null); await qc.invalidateQueries({ queryKey: keyOf(id) }); };

  const save = useMutation({
    mutationFn: () => api.put(`/api/v1/workflows/${id}/definition`, { definition: def }, WorkflowSchema),
    onSuccess: refresh,
  });
  const check = useMutation({ mutationFn: () => api.post(`/api/v1/workflows/${id}/validate`, {}, ValidationReportSchema) });
  const publish = useMutation({ mutationFn: () => api.post(`/api/v1/workflows/${id}/publish-request`, {}, WorkflowSchema), onSuccess: refresh });
  const approve = useMutation({ mutationFn: () => api.post(`/api/v1/workflows/${id}/approve`, {}, WorkflowSchema), onSuccess: refresh });
  const start = useMutation({
    mutationFn: () => api.post(`/api/v1/workflows/${id}/runs`, { parameters: params }, ExecutionSchema),
    onSuccess: (run) => setRunId(run.id),
  });
  const runs = useQuery({ queryKey: [...keyOf(id), 'runs'], queryFn: () => api.get(`/api/v1/workflows/${id}/runs`, ExecutionListResponse), enabled: workflow.data?.status === 'published' && session.can('execution.start') });
  const activeId = runId ?? runs.data?.items[0]?.id ?? null;
  const run = useQuery({
    queryKey: ['execution', activeId],
    queryFn: () => api.get(`/api/v1/executions/${activeId}`, ExecutionSchema),
    enabled: Boolean(activeId),
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? 1000 : false),
  });
  const events = useQuery({
    queryKey: ['execution', activeId, 'events'],
    queryFn: () => api.get(`/api/v1/executions/${activeId}/events`, ExecutionEventList),
    enabled: Boolean(activeId),
    refetchInterval: () => (run.data?.status === 'queued' || run.data?.status === 'running' ? 1000 : false),
  });

  const patch = (next: Def) => setEdited(next);
  const generation = workflow.data?.type === 'requirement-validation';
  const steps = (def?.spec?.steps ?? []).filter((s) => !(generation && ['rv.execute-tests', 'rv.sync-results', 'rv.qa-report'].includes(s.type)));
  const enabled = steps.filter((s) => s.enabled !== false);

  return (
    <>
      <PageHeader title={workflow.data?.name ?? 'Workflow'} description={workflow.data ? `${workflow.data.status}${workflow.data.publishedVersion ? ` · version ${workflow.data.publishedVersion}` : ''}` : 'Loading the workflow.'} />
      <p className="mb-4"><Link to="/workflows" className="text-blue-700 underline dark:text-blue-300">All workflows</Link></p>
      {workflow.isError && <ErrorNotice message="This workflow could not be loaded." onRetry={() => void workflow.refetch()} />}
      {def && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(['steps', 'flow', 'connectors', 'check', 'run'] as const).map((t) => (
              <button key={t} type="button" className={buttonClass} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
            ))}
          </div>
          {tab === 'steps' && (
            <Card label="Steps">
              {generation && <p className="mb-3">This workflow ends when the test cases are stored in Squash. Execution is a later action on Executions, for one work item and one environment.</p>}
              {steps.length === 0 && <p>This draft has no steps. Create it from a template to get the guided list.</p>}
              <ul className="space-y-2">
                {steps.map((s) => (
                  <li key={s.id} className="flex items-center gap-3">
                    <input type="checkbox" checked={s.enabled !== false} disabled={!canEdit || s.mandatory === true || s.locked === true} onChange={(e) => patch({ ...def, spec: { ...def.spec, steps: steps.map((x) => x.id === s.id ? { ...x, enabled: e.target.checked } : x) } })} />
                    <span>{s.id} · {s.type}{s.mandatory ? ' · required' : ''}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {tab === 'flow' && (
            <Card label="Flow">
              <p>The picture follows the step list. It is not edited here.</p>
              <p className="mt-3">{enabled.length === 0 ? 'No steps are on.' : enabled.map((s) => s.id).join(' → ')}</p>
            </Card>
          )}
          {tab === 'connectors' && (
            <Card label="Connectors">
              <p>Choose a connector you already set up. The list shows its name. Leave a role on None when that step is turned off. Then use Save draft.</p>
              {(def.spec?.connectors ?? []).map((c) => {
                const current = c.binding?.connectorInstanceId ?? '';
                if (c.category === 'test-runner') {
                  return <Field key={c.role} id={`role-${c.role}`} label={ROLE_LABEL[c.role] ?? c.role}><input id={`role-${c.role}`} className={fieldClass} disabled value="Platform runner" /></Field>;
                }
                const options = (savedConnectors.data?.items ?? []).filter((item) => item.category === c.category);
                const known = options.some((item) => item.id === current);
                return (
                  <Field key={c.role} id={`role-${c.role}`} label={ROLE_LABEL[c.role] ?? c.role}>
                    <select id={`role-${c.role}`} className={fieldClass} disabled={!canEdit} value={current === 'managed' ? '' : current} onChange={(e) => patch({ ...def, spec: { ...def.spec, connectors: (def.spec?.connectors ?? []).map((x) => x.role === c.role ? { ...x, binding: { connectorInstanceId: e.target.value || null } } : x) } })}>
                      <option value="">None</option>
                      {current && !known && <option value={current}>Saved connector</option>}
                      {options.map((item) => <option key={item.id} value={item.id}>{item.name}{item.enabled ? '' : ' (disabled)'}</option>)}
                    </select>
                  </Field>
                );
              })}
            </Card>
          )}
          {tab === 'check' && (
            <Card label="Check">
              <button type="button" className={primaryButtonClass} onClick={() => check.mutate()} disabled={check.isPending}>Check this workflow</button>
              {check.isError && <div className="mt-3"><ErrorNotice message={errorText(check.error, 'The check failed.')} /></div>}
              <ul className="mt-3 space-y-2">
                {check.data?.issues.map((i, n) => <li key={`${i.ruleId}-${n}`}>{i.severity === 'warning' ? 'Warning' : i.ruleId}: {i.message} {i.fixHint}</li>)}
                {check.data?.issues.length === 0 && <li>Nothing is blocking publish.</li>}
              </ul>
              {(def.spec?.approvals ?? []).length > 0 && <p className="mt-3">Approvals: {(def.spec?.approvals ?? []).map((a) => a.when).join(', ')}</p>}
            </Card>
          )}
          {tab === 'run' && (
            <Card label="Run">
              {workflow.data?.status !== 'published' && <p>Publish this workflow before starting a run. The worker runs the steps; this page only asks it to start.</p>}
              {workflow.data?.status === 'published' && session.can('execution.start') && (
                <form onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
                  {generation && <p className="mb-3">Starting this run creates the test cases. Choose the environment on Executions when you run the work item.</p>}
                  {(def.spec?.parameters ?? []).filter((p) => p.required && (p.pinned === undefined || p.pinned === null) && !(generation && p.name === 'environment')).map((p) => (
                    <Field key={p.name} id={`param-${p.name}`} label={`${p.name} (${p.type})`} hint={p.type === 'work-item-ref' ? 'First line is the work item id. Add a heading Acceptance criteria, then one criterion on each line. Each line becomes a test case.' : undefined}>
                      {p.type === 'work-item-ref'
                        ? <textarea id={`param-${p.name}`} rows={6} className={fieldClass} value={params[p.name] ?? ''} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} />
                        : <input id={`param-${p.name}`} className={fieldClass} value={params[p.name] ?? ''} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} />}
                    </Field>
                  ))}
                  <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={start.isPending}>Start run</button>
                  {start.isError && <div className="mt-3"><ErrorNotice message={errorText(start.error, 'The run could not be started.')} /></div>}
                </form>
              )}
              {run.data && <p className="mt-3">Run {run.data.id.slice(0, 8)} is {run.data.status}, at step {run.data.stepIndex}. A queued run moves when the worker is up.</p>}
              {events.data && events.data.items.some((event) => event.kind === 'step.completed' || event.kind === 'step.failed') && (
                <ul className="mt-3 space-y-2">
                  {events.data.items.filter((event) => event.kind === 'step.completed' || event.kind === 'step.failed').map((event) => (
                    <li key={event.seq}>{event.kind === 'step.failed' ? 'Failed' : 'Done'}. {typeof event.payload.summary === 'string' && event.payload.summary ? event.payload.summary : String(event.payload.stepId ?? event.kind)}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <div className="flex flex-wrap gap-2">
            {canEdit && <button type="button" className={primaryButtonClass} disabled={save.isPending || !edited} onClick={() => save.mutate()}>Save draft</button>}
            {draft && session.can('workflow.publish.request') && <button type="button" className={buttonClass} disabled={publish.isPending} onClick={() => publish.mutate()}>Send for approval</button>}
            {workflow.data?.status === 'in_review' && session.can('workflow.publish.approve') && <button type="button" className={primaryButtonClass} disabled={approve.isPending} onClick={() => approve.mutate()}>Approve and publish</button>}
          </div>
          {(save.isError || publish.isError || approve.isError) && <ErrorNotice message={errorText(save.error ?? publish.error ?? approve.error, 'That change was rejected.')} />}
        </div>
      )}
    </>
  );
}
