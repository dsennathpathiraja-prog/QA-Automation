import { IdentityMappingsResponse } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api/context';
import { Card, ErrorNotice, PageHeader } from './common';

const ROLE_LABEL: Record<string, string> = { administrator: 'Administrator', qa_lead: 'QA Lead', qa_engineer: 'QA Engineer', business_user: 'Business User' };

export function IdentityMapping() {
  const api = useApi();
  const q = useQuery({ queryKey: ['identity-mappings'], queryFn: () => api.get('/api/v1/identity/mappings', IdentityMappingsResponse) });
  return (
    <>
      <PageHeader title="Identity mapping" description="Members of these identity provider groups receive the platform role shown. A person in several groups gets the combined access." />
      {q.isError && <ErrorNotice message="The mapping could not be loaded." onRetry={() => void q.refetch()} />}
      {q.isPending && <p role="status">Loading mapping…</p>}
      {q.data && (
        <Card label="Group to role mapping">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Identity provider group to platform role mapping</caption>
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th scope="col" className="py-2 pr-4">Identity provider group</th>
                <th scope="col" className="py-2 pr-4">Platform role</th>
                <th scope="col" className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((m) => (
                <tr key={m.idpGroup} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-2 pr-4 font-mono">{m.idpGroup}</td>
                  <td className="py-2 pr-4">{ROLE_LABEL[m.role] ?? m.role}</td>
                  <td className="py-2">{m.enabled ? 'Enabled' : 'Disabled'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">Editing the mapping is delivered in Phase 10.</p>
        </Card>
      )}
    </>
  );
}
