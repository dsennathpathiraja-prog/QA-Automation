import { type ConnectorDetail, type ZodType } from '@qa/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../api/context';
import { useSession } from '../../auth/session';
import { ErrorNotice } from '../common';
import { CapabilityTable, buttonClass, connectorKey, errorText, primaryButtonClass, when } from './shared';

const Anything = { parse: (v: unknown) => v } as unknown as ZodType<unknown>;

/** Test Connection, what the test found, and any outbound address that still needs approving. */
export function TestPanel({ detail }: { detail: ConnectorDetail }) {
  const api = useApi();
  const qc = useQueryClient();
  const session = useSession();
  const refresh = () => qc.invalidateQueries({ queryKey: connectorKey(detail.id) });
  const run = useMutation({ mutationFn: () => api.post(`/api/v1/connectors/${detail.id}/test`, undefined, Anything), onSuccess: refresh });
  const approve = useMutation({
    mutationFn: (h: { hostPattern: string; internal: boolean; allowHttp: boolean }) => api.post('/api/v1/egress/hosts', h, Anything),
    onSuccess: refresh,
  });
  const t = detail.latestTest;
  const running = t?.status === 'pending' || t?.status === 'running';
  const canManage = session.can('connector.manage');

  return (
    <div>
      {detail.hostIssues.length > 0 && (
        <div role="status" className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          {detail.hostIssues.map((h) => (
            <div key={h.host} className="mb-2 last:mb-0">
              <p>
                <strong>{h.host}</strong>{' '}
                {h.reason === 'not-approved' ? 'is not on the approved-host list, so the platform will not connect to it.' : 'is approved for secure connections only, but this connector uses plain http.'}
              </p>
              {session.can('security.policy.manage') ? (
                <button type="button" className={`${buttonClass} mt-2`} disabled={approve.isPending} onClick={() => approve.mutate(h.suggestion)}>
                  Approve {h.suggestion.hostPattern}
                  {h.suggestion.allowHttp ? ' (internal, plain http)' : h.suggestion.internal ? ' (internal)' : ''}
                </button>
              ) : (
                <p className="mt-1 text-sm">Ask an Administrator to approve this address.</p>
              )}
            </div>
          ))}
          {approve.isError && <p className="mt-2">{errorText(approve.error, 'The host could not be approved.')}</p>}
        </div>
      )}

      {canManage && (
        <button type="button" className={primaryButtonClass} disabled={run.isPending || running} onClick={() => run.mutate()}>
          {running ? 'Testing…' : 'Test connection'}
        </button>
      )}
      {run.isError && <div className="mt-3"><ErrorNotice message={errorText(run.error, 'The test could not be started.')} /></div>}

      <div aria-live="polite" className="mt-3">
        {running && <p role="status">Testing the connection. The worker is checking it now.</p>}
        {t && !running && t.result && (
          <p role={t.result.ok ? 'status' : 'alert'} className={t.result.ok ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}>
            {t.result.ok ? 'Test passed' : 'Test failed'}: {t.result.message}
            {t.finishedAt && <span className="text-slate-600 dark:text-slate-300"> ({when(t.finishedAt)})</span>}
          </p>
        )}
        {!t && <p className="text-sm text-slate-600 dark:text-slate-300">This connector has not been tested yet.</p>}
      </div>

      {detail.permissionReport && (
        <div className="mt-4">
          <h3 className="font-medium">Permissions found</h3>
          <p className="text-sm">{detail.permissionReport.granted.length > 0 ? detail.permissionReport.granted.join(', ') : 'None reported'}</p>
          {detail.permissionReport.writePermissionsDetected.length > 0 && (
            <p className="text-sm text-amber-800 dark:text-amber-200">Write permissions detected: {detail.permissionReport.writePermissionsDetected.join(', ')}. The platform only reads through this connector.</p>
          )}
          {detail.permissionReport.notes?.map((n) => (
            <p key={n} className="text-sm text-slate-600 dark:text-slate-300">{n}</p>
          ))}
        </div>
      )}

      <div className="mt-4">
        <h3 className="mb-2 font-medium">What this connector can do</h3>
        <CapabilityTable capabilities={detail.capabilities} />
      </div>
    </div>
  );
}
