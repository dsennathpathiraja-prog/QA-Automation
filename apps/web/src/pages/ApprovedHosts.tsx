import { ApprovedHostListResponse, type ApproveHostRequest } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/context';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, buttonClass, errorText, fieldClass, primaryButtonClass, when } from './connectors/shared';

const key = ['egress-hosts'] as const;
const Anything = { parse: (v: unknown) => v } as never;

export function ApprovedHosts() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: key, queryFn: () => api.get('/api/v1/egress/hosts', ApprovedHostListResponse) });
  const [host, setHost] = useState('');
  const [internal, setInternal] = useState(true);
  const [allowHttp, setAllowHttp] = useState(false);
  const add = useMutation({
    mutationFn: (b: ApproveHostRequest) => api.post('/api/v1/egress/hosts', b, Anything),
    onSuccess: async () => {
      setHost('');
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/api/v1/egress/hosts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: key }) });

  return (
    <>
      <PageHeader title="Approved hosts" description="The only addresses connectors may reach. Anything not on this list is refused, even if a connector is configured to use it." />
      <div className="space-y-4">
        <Card label="Approve a host">
          <form onSubmit={(e) => { e.preventDefault(); add.mutate({ hostPattern: host, internal, allowHttp: internal && allowHttp }); }}>
            <Field id="h-host" label="Host name" hint="For example squash.example.com or *.example.com. No scheme, port or path.">
              <input id="h-host" required className={fieldClass} value={host} onChange={(e) => setHost(e.target.value)} />
            </Field>
            <div className="mt-3 space-y-1 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={internal} onChange={(e) => { setInternal(e.target.checked); if (!e.target.checked) setAllowHttp(false); }} /> This host is inside our network</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={allowHttp} disabled={!internal} onChange={(e) => setAllowHttp(e.target.checked)} /> Allow plain http (internal hosts only)</label>
            </div>
            <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending}>Approve host</button>
            {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The host could not be approved.')} /></div>}
          </form>
        </Card>
        <Card label="Approved hosts">
          {q.isError && <ErrorNotice message="The approved hosts could not be loaded." onRetry={() => void q.refetch()} />}
          {q.data && q.data.items.length === 0 && <p>No hosts have been approved yet, so connectors cannot reach any system.</p>}
          {q.data && q.data.items.length > 0 && (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Approved hosts</caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4">Host</th>
                  <th scope="col" className="py-2 pr-4">Where</th>
                  <th scope="col" className="py-2 pr-4">Plain http</th>
                  <th scope="col" className="py-2 pr-4">Approved</th>
                  <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((h) => (
                  <tr key={h.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 pr-4 font-mono">{h.hostPattern}</td>
                    <td className="py-2 pr-4">{h.internal ? 'Inside our network' : 'External'}</td>
                    <td className="py-2 pr-4">{h.allowHttp ? 'Allowed' : 'Not allowed'}</td>
                    <td className="py-2 pr-4">{when(h.approvedAt)}</td>
                    <td className="py-2"><button type="button" className={buttonClass} onClick={() => remove.mutate(h.id)} aria-label={`Remove ${h.hostPattern}`}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {remove.isError && <div className="mt-3"><ErrorNotice message={errorText(remove.error, 'The host could not be removed.')} /></div>}
        </Card>
      </div>
    </>
  );
}
