import { ConnectorListResponse } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api/context';
import { Card, ErrorNotice, PageHeader } from './common';

export function Connectors() {
  const api = useApi();
  const q = useQuery({ queryKey: ['connectors'], queryFn: () => api.get('/api/v1/connectors', ConnectorListResponse) });
  return (
    <>
      <PageHeader title="Connectors" description="Connections to work item systems, source repositories, test management and browser automation." />
      {q.isError && <ErrorNotice message="The connector list could not be loaded." onRetry={() => void q.refetch()} />}
      {q.isPending && <p role="status">Loading connectors…</p>}
      {q.data && q.data.items.length === 0 && (
        <Card label="No connectors">
          <p>No connectors have been configured yet.</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Guided setup for Azure Boards, Jira, GitHub, Azure DevOps, Squash and Playwright arrives in Phase 2.</p>
        </Card>
      )}
      {q.data && q.data.items.length > 0 && (
        <ul className="space-y-2">
          {q.data.items.map((c) => (
            <li key={c.id}>
              <Card>
                <span className="font-medium">{c.name}</span> <span className="text-sm text-slate-600">{c.providerKey} · {c.status}</span>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
