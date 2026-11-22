import { AutomationAssetSchema, AutomationMappingListResponse, AutomationResolveResponse } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';

export function AutomationMapping() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const [resolveId, setResolveId] = useState('');
  const [resolved, setResolved] = useState('');
  const mappings = useQuery({
    queryKey: ['automation-mappings'],
    queryFn: () => api.get('/api/v1/automation/mappings', AutomationMappingListResponse),
  });

  const approveAsset = useMutation({
    mutationFn: (assetId: string) => api.post(`/api/v1/automation/assets/${assetId}/approve`, {}, AutomationAssetSchema),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['automation-mappings'] }),
  });

  const resolve = useMutation({
    mutationFn: (squashCaseId: string) =>
      api.get(`/api/v1/automation/resolve?squashCaseId=${encodeURIComponent(squashCaseId)}`, AutomationResolveResponse),
    onSuccess: (data) => {
      setResolved(
        `Squash ${data.squashCaseId} → asset ${data.assetId} (${data.assetKey}, ${data.status})${data.approved ? ' — approved for Regression' : ' — still draft'}`,
      );
    },
    onError: () => setResolved('No mapping for that Squash case id.'),
  });

  return (
    <>
      <PageHeader
        title="Automation Mapping"
        description="Link Squash cases to platform Playwright scripts. Approve a draft asset before Regression can treat it as runnable. Full Regression collections and campaigns come later."
      />
      {mappings.isError && <ErrorNotice message="Mappings could not be loaded." onRetry={() => void mappings.refetch()} />}
      {mappings.isPending && <p role="status">Loading mappings…</p>}
      {mappings.data && (
        <Card label="Squash case to platform script">
          {mappings.data.items.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              No mappings yet. Publishing generated cases to Squash seeds a draft asset and mapping automatically. You can also register via{' '}
              <code className="text-xs">POST /api/v1/automation/assets</code> with a <code className="text-xs">squashCaseId</code>.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Squash case to platform automation asset mapping</caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4">Squash case</th>
                  <th scope="col" className="py-2 pr-4">Reference</th>
                  <th scope="col" className="py-2 pr-4">Asset id</th>
                  <th scope="col" className="py-2 pr-4">Script</th>
                  <th scope="col" className="py-2 pr-4">Status</th>
                  {session.can('automation.approve') && <th scope="col" className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {mappings.data.items.map((m) => (
                  <tr key={m.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="py-2 pr-4 font-mono">{m.squashCaseId}</td>
                    <td className="py-2 pr-4 font-mono">{m.squashReference || '—'}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{m.assetId}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{m.scriptPath}</td>
                    <td className="py-2 pr-4">{m.status === 'approved' ? 'Approved' : 'Draft'}</td>
                    {session.can('automation.approve') && (
                      <td className="py-2">
                        {m.status === 'draft' ? (
                          <button
                            type="button"
                            className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
                            disabled={approveAsset.isPending}
                            onClick={() => approveAsset.mutate(m.assetId)}
                          >
                            Approve
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Card label="Resolve Squash case">
        <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
          Look up the platform automation asset id for a Squash case (same as{' '}
          <code className="text-xs">GET /api/v1/automation/resolve?squashCaseId=…</code>).
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (resolveId.trim()) resolve.mutate(resolveId.trim());
          }}
        >
          <label className="text-sm">
            Squash case id
            <input
              className="mt-1 block rounded border border-slate-300 px-2 py-1 font-mono text-sm dark:border-slate-600 dark:bg-slate-950"
              value={resolveId}
              onChange={(e) => setResolveId(e.target.value)}
              placeholder="238"
            />
          </label>
          <button type="submit" className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-600" disabled={resolve.isPending}>
            Resolve
          </button>
        </form>
        {resolved && <p className="mt-3 text-sm" role="status">{resolved}</p>}
      </Card>
    </>
  );
}
