import { ConnectorDetailSchema, OperationLogResponse, type ConnectorDetail, type ProviderView } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useSession } from '../../auth/session';
import { Card, ErrorNotice, PageHeader } from '../common';
import { TestPanel } from './TestPanel';
import { DescriptorFields, EnabledBadge, StatusBadge, buttonClass, connectorKey, connectorsKey, errorText, primaryButtonClass, useProviders, when } from './shared';

export function ConnectorDetailPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const q = useQuery({
    queryKey: connectorKey(id),
    queryFn: () => api.get(`/api/v1/connectors/${id}`, ConnectorDetailSchema),
    refetchInterval: (query) => {
      const s = query.state.data?.latestTest?.status;
      return s === 'pending' || s === 'running' ? 1_500 : false;
    },
  });
  const providers = useProviders();

  if (q.isError) return (
    <>
      <PageHeader title="Connector" />
      <ErrorNotice message={errorText(q.error, 'The connector could not be loaded.')} onRetry={() => void q.refetch()} />
      <p className="mt-3"><Link to="/connectors" className="text-blue-700 underline dark:text-blue-300">Back to connectors</Link></p>
    </>
  );
  if (!q.data) return <p role="status">Loading connector…</p>;
  const provider = providers.data?.items.find((p) => p.providerKey === q.data.providerKey);
  return <Detail detail={q.data} provider={provider} />;
}

function Detail({ detail, provider }: { detail: ConnectorDetail; provider?: ProviderView }) {
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const navigate = useNavigate();
  const canManage = session.can('connector.manage');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: connectorKey(detail.id) });
    await qc.invalidateQueries({ queryKey: connectorsKey });
  };
  const act = useMutation({
    mutationFn: (action: 'enable' | 'disable' | 'disconnect') => api.post(`/api/v1/connectors/${detail.id}/${action}`, undefined, ConnectorDetailSchema),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/connectors/${detail.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: connectorsKey });
      await navigate({ to: '/connectors' });
    },
  });
  const [confirm, setConfirm] = useState<'disconnect' | 'remove' | undefined>();

  return (
    <>
      <PageHeader title={detail.name} description={`${detail.providerName}. Read-only access: the platform never changes anything in this system.`} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusBadge status={detail.status} />
        <EnabledBadge enabled={detail.enabled} />
        <span className="text-sm text-slate-600 dark:text-slate-300">Last successful connection: {when(detail.lastSuccessAt)}</span>
      </div>

      {canManage && (
        <div className="mb-4 flex flex-wrap gap-2">
          {detail.enabled ? (
            <button type="button" className={buttonClass} disabled={act.isPending} onClick={() => act.mutate('disable')}>Switch off</button>
          ) : (
            <button type="button" className={primaryButtonClass} disabled={act.isPending || !detail.canEnable} title={detail.canEnable ? undefined : 'Run a successful test first'} onClick={() => act.mutate('enable')}>
              Switch on
            </button>
          )}
          {detail.status !== 'disconnected' && (
            <button type="button" className={buttonClass} onClick={() => setConfirm('disconnect')}>Disconnect</button>
          )}
          {(detail.status === 'draft' || detail.status === 'disconnected') && (
            <button type="button" className={buttonClass} onClick={() => setConfirm('remove')}>Remove</button>
          )}
        </div>
      )}
      {act.isError && <div className="mb-3"><ErrorNotice message={errorText(act.error, 'That action could not be completed.')} /></div>}
      {remove.isError && <div className="mb-3"><ErrorNotice message={errorText(remove.error, 'The connector could not be removed.')} /></div>}
      {confirm && (
        <div role="alertdialog" aria-label="Confirm" className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p>
            {confirm === 'disconnect'
              ? 'Disconnecting switches this connector off and deletes its stored credentials. The record and its history stay.'
              : 'Removing deletes this connector from the list. Its history stays in the audit log.'}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={primaryButtonClass} onClick={() => { setConfirm(undefined); if (confirm === 'disconnect') act.mutate('disconnect'); else remove.mutate(); }}>
              {confirm === 'disconnect' ? 'Disconnect' : 'Remove'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setConfirm(undefined)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        <Card label="Connection test">
          <h2 className="mb-2 text-lg font-semibold">Connection</h2>
          <TestPanel detail={detail} />
        </Card>
        {canManage && provider && detail.status !== 'disconnected' && <SettingsCard detail={detail} provider={provider} onSaved={refresh} />}
        {canManage && provider && provider.authMethods.length > 0 && <CredentialsCard detail={detail} provider={provider} onSaved={refresh} />}
        {session.can('audit.read') && <OperationsCard id={detail.id} />}
      </div>
    </>
  );
}

function SettingsCard({ detail, provider, onSaved }: { detail: ConnectorDetail; provider: ProviderView; onSaved(): Promise<void> }) {
  const api = useApi();
  const initial = Object.fromEntries(Object.entries(detail.config ?? {}).map(([k, v]) => [k, String(v ?? '')]));
  const [name, setName] = useState(detail.name);
  const [values, setValues] = useState<Record<string, string>>(initial);
  const save = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = { ...(detail.config ?? {}) };
      for (const f of provider.configFields) config[f.name] = values[f.name] ?? '';
      return api.patch(`/api/v1/connectors/${detail.id}`, { name, config }, ConnectorDetailSchema);
    },
    onSuccess: onSaved,
  });
  return (
    <Card label="Settings">
      <h2 className="text-lg font-semibold">Settings</h2>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="mt-3">
          <label htmlFor="s-name" className="block text-sm font-medium">Name</label>
          <input id="s-name" className="mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-600 dark:bg-slate-950" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DescriptorFields provider={provider} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} include={{ settings: true, credentials: false }} idPrefix="s" />
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">Changing connection settings switches the connector off until it is tested again.</p>
        <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={save.isPending}>Save settings</button>
        {save.isError && <div className="mt-3"><ErrorNotice message={errorText(save.error, 'The settings could not be saved.')} /></div>}
      </form>
    </Card>
  );
}

function CredentialsCard({ detail, provider, onSaved }: { detail: ConnectorDetail; provider: ProviderView; onSaved(): Promise<void> }) {
  const api = useApi();
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api.put(`/api/v1/connectors/${detail.id}/credentials`, { secrets: values }, ConnectorDetailSchema),
    onSuccess: async () => {
      setValues({});
      await onSaved();
    },
  });
  return (
    <Card label="Credentials">
      <h2 className="text-lg font-semibold">Credentials</h2>
      <p className="text-sm">{detail.hasCredentials ? 'Credentials are stored. Their values are never shown.' : 'No credentials are stored.'}</p>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <DescriptorFields provider={provider} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} include={{ settings: false, credentials: true }} idPrefix="c" />
        <button type="submit" className={`${buttonClass} mt-3`} disabled={save.isPending}>Replace credentials</button>
        {save.isError && <div className="mt-3"><ErrorNotice message={errorText(save.error, 'The credentials could not be saved.')} /></div>}
      </form>
    </Card>
  );
}

function OperationsCard({ id }: { id: string }) {
  const api = useApi();
  const q = useQuery({ queryKey: ['connector-operations', id], queryFn: () => api.get(`/api/v1/connectors/${id}/operations?limit=25`, OperationLogResponse) });
  return (
    <Card label="Operation log">
      <h2 className="text-lg font-semibold">Operation log</h2>
      <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">Every call the platform made through this connector, including calls it refused. Request contents are not stored.</p>
      {q.isError && <ErrorNotice message="The operation log could not be loaded." onRetry={() => void q.refetch()} />}
      {q.data && q.data.items.length === 0 && <p className="text-sm">Nothing has been called through this connector yet.</p>}
      {q.data && q.data.items.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Recent connector calls</caption>
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-700">
              <th scope="col" className="py-2 pr-4">When</th>
              <th scope="col" className="py-2 pr-4">Capability</th>
              <th scope="col" className="py-2 pr-4">Caller</th>
              <th scope="col" className="py-2 pr-4">Result</th>
              <th scope="col" className="py-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {q.data.items.map((r) => (
              <tr key={r.seq} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="py-2 pr-4">{when(r.at)}</td>
                <td className="py-2 pr-4 font-mono">{r.capability}</td>
                <td className="py-2 pr-4">{r.actorId}</td>
                <td className="py-2 pr-4">{r.outcome === 'ok' ? 'Succeeded' : r.outcome === 'denied' ? `Refused${r.denialReason ? `: ${r.denialReason}` : ''}` : `Failed${r.errorClass ? ` (${r.errorClass})` : ''}`}</td>
                <td className="py-2">{r.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
