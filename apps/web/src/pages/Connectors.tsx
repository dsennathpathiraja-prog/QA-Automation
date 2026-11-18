import { ConnectorListResponse } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';
import { EnabledBadge, StatusBadge, connectorsKey, primaryButtonClass, when } from './connectors/shared';

export function Connectors() {
  const api = useApi();
  const session = useSession();
  const q = useQuery({ queryKey: connectorsKey, queryFn: () => api.get('/api/v1/connectors', ConnectorListResponse) });
  const canManage = session.can('connector.manage');

  return (
    <>
      <PageHeader title="Connectors" description="Connections to work item systems, source repositories, test management and browser automation." />
      {canManage && (
        <p className="mb-4">
          <Link to="/connectors/new" className={primaryButtonClass}>
            Add connector
          </Link>
        </p>
      )}
      {q.isError && <ErrorNotice message="The connector list could not be loaded." onRetry={() => void q.refetch()} />}
      {q.isPending && <p role="status">Loading connectors…</p>}
      {q.data && q.data.items.length === 0 && (
        <Card label="No connectors">
          <p>No connectors have been configured yet.</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            {canManage ? 'Choose Add connector to connect a system. The guided steps check the connection before anything is switched on.' : 'An Administrator can add connectors.'}
          </p>
        </Card>
      )}
      {q.data && q.data.items.length > 0 && (
        <Card label="Connectors">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Configured connectors</caption>
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th scope="col" className="py-2 pr-4">Name</th>
                <th scope="col" className="py-2 pr-4">Type</th>
                <th scope="col" className="py-2 pr-4">Status</th>
                <th scope="col" className="py-2 pr-4">Use</th>
                <th scope="col" className="py-2">Last successful connection</th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                  <td className="py-2 pr-4">
                    <Link to="/connectors/$id" params={{ id: c.id }} className="text-blue-700 underline dark:text-blue-300">
                      {c.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{c.providerName}</td>
                  <td className="py-2 pr-4"><StatusBadge status={c.status} /></td>
                  <td className="py-2 pr-4"><EnabledBadge enabled={c.enabled} /></td>
                  <td className="py-2">{when(c.lastSuccessAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
