import { EnvironmentDetailSchema, EnvironmentListResponse } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

export const environmentsKey = ['environments'] as const;

type Kind = 'development' | 'qa' | 'staging' | 'uat' | 'production';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'development', label: 'Development' },
  { value: 'qa', label: 'QA' },
  { value: 'staging', label: 'Staging' },
  { value: 'uat', label: 'UAT' },
  { value: 'production', label: 'Production' },
];

export const kindLabel = (kind: string) => KINDS.find((k) => k.value === kind)?.label ?? kind;

export function Environments() {
  const api = useApi();
  const session = useSession();
  const manage = session.can('environment.manage');
  const q = useQuery({ queryKey: environmentsKey, queryFn: () => api.get('/api/v1/environments', EnvironmentListResponse) });

  return (
    <>
      <PageHeader title="Environments" description="Where a workflow runs: the application address, browser, sign-in, test data and which connectors it may use." />
      <div className="space-y-4">
        {manage && <NewEnvironment />}
        <Card label="Configured environments">
          {q.isError && <ErrorNotice message="The environments could not be loaded." onRetry={() => void q.refetch()} />}
          {q.data && q.data.items.length === 0 && <p>No environments have been configured yet.</p>}
          {q.data && q.data.items.length > 0 && (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Environments</caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4">Name</th>
                  <th scope="col" className="py-2 pr-4">Kind</th>
                  <th scope="col" className="py-2 pr-4">Application</th>
                  <th scope="col" className="py-2">Selectable</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((e) => (
                  <tr key={e.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 pr-4"><Link to="/environments/$id" params={{ id: e.id }} className="text-blue-700 underline dark:text-blue-300">{e.name}</Link></td>
                    <td className="py-2 pr-4">{kindLabel(e.kind)}</td>
                    <td className="py-2 pr-4 font-mono">{e.applicationUrl}</td>
                    <td className="py-2">{e.selectable ? 'Yes' : e.kind === 'production' ? 'Needs authorization' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function NewEnvironment() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('qa');
  const [applicationUrl, setApplicationUrl] = useState('');
  const add = useMutation({
    mutationFn: (body: { name: string; kind: Kind; applicationUrl: string; restrictions?: { prodSafeOnly: boolean; maxParallelism: number } }) => api.post('/api/v1/environments', body, EnvironmentDetailSchema),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: environmentsKey });
      await navigate({ to: '/environments/$id', params: { id: created.id } });
    },
  });
  return (
    <Card label="New environment">
      <form onSubmit={(e) => { e.preventDefault(); add.mutate({ name, kind, applicationUrl, restrictions: kind === 'production' ? { prodSafeOnly: true, maxParallelism: 1 } : undefined }); }}>
        <Field id="env-name" label="Name"><input id="env-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field id="env-kind" label="Kind">
          <select id="env-kind" className={fieldClass} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field id="env-url" label="Application URL" hint="The host must already be approved for applications.">
          <input id="env-url" required type="url" className={fieldClass} value={applicationUrl} onChange={(e) => setApplicationUrl(e.target.value)} />
        </Field>
        {kind === 'production' && <p className="mt-3 text-sm">Production stays unselectable until an Administrator grants an authorization. Runs are limited to cases marked prod-safe.</p>}
        <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending}>Create environment</button>
        {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The environment could not be created.')} /></div>}
      </form>
    </Card>
  );
}
