import {
  AutomationAssetSchema,
  AutomationMappingListResponse,
  AutomationResolveResponse,
  RegressionResolveResponse,
} from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';

const reasonLabel = (reason: string) => {
  if (reason === 'mapping-unapproved') return 'Draft (not approved)';
  if (reason === 'no-mapping') return 'No mapping';
  if (reason === 'asset-missing') return 'Asset missing';
  return reason;
};

const parseCaseIds = (raw: string) =>
  [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];

export function AutomationMapping() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const [resolveId, setResolveId] = useState('');
  const [resolved, setResolved] = useState('');
  const [prepIds, setPrepIds] = useState('');
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

  const prep = useMutation({
    mutationFn: (squashCaseIds: string[]) =>
      api.post('/api/v1/automation/resolve-regression', { squashCaseIds }, RegressionResolveResponse),
  });

  return (
    <>
      <PageHeader
        title="Automation Mapping"
        description="Link Squash cases to platform Playwright scripts. Approve a draft asset before Regression can run it. Regression prep below lists approved vs Not Automated — no generation or explore."
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
          <code className="text-xs">GET /api/v1/automation/resolve?squashCaseId=…</code>). Draft or approved.
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

      <Card label="Regression prep (approved-only)">
        <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
          Preview what <code className="text-xs">rg.resolve-automation</code> will run before execute. Only approved mappings are resolved;
          draft, unmapped, or missing assets are Not Automated (
          <code className="text-xs">mapping-unapproved</code> | <code className="text-xs">no-mapping</code> | <code className="text-xs">asset-missing</code>
          ). Nothing is generated or explored.
        </p>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            const ids = parseCaseIds(prepIds);
            if (ids.length > 0) prep.mutate(ids);
          }}
        >
          <label className="block text-sm">
            Squash case ids (comma, space, or newline separated)
            <textarea
              className="mt-1 block w-full rounded border border-slate-300 px-2 py-1 font-mono text-sm dark:border-slate-600 dark:bg-slate-950"
              rows={3}
              value={prepIds}
              onChange={(e) => setPrepIds(e.target.value)}
              placeholder={'238\n239'}
            />
          </label>
          <button type="submit" className="rounded border border-slate-300 px-3 py-1 text-sm dark:border-slate-600" disabled={prep.isPending}>
            Preview Regression resolve
          </button>
        </form>
        {prep.isError && <p className="mt-2 text-sm text-red-700 dark:text-red-300" role="alert">Regression resolve failed.</p>}
        {prep.data && (
          <div className="mt-4 space-y-3 text-sm" role="status">
            <p>
              {prep.data.resolved.length} approved · {prep.data.notAutomated.length} Not Automated
            </p>
            {prep.data.resolved.length > 0 && (
              <div>
                <h3 className="font-medium">Resolved (approved)</h3>
                <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                  {prep.data.resolved.map((row) => (
                    <li key={row.squashCaseId}>
                      {row.squashCaseId} → {row.assetId} ({row.assetKey}, {row.scriptPath})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {prep.data.notAutomated.length > 0 && (
              <div>
                <h3 className="font-medium">Not Automated</h3>
                <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                  {prep.data.notAutomated.map((row) => (
                    <li key={`${row.squashCaseId}-${row.reason}`}>
                      {row.squashCaseId} — {reasonLabel(row.reason)} ({row.reason})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
