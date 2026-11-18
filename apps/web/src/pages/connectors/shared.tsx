import type { ConnectorDetail, ProviderView } from '@qa/contracts';
import { ProviderListResponse } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';

export const providersKey = ['connector-providers'] as const;
export const connectorsKey = ['connectors'] as const;
export const connectorKey = (id: string) => ['connector', id] as const;

export function useProviders() {
  const api = useApi();
  return useQuery({ queryKey: providersKey, queryFn: () => api.get('/api/v1/connector-providers', ProviderListResponse) });
}

export const errorText = (e: unknown, fallback: string): string => (e instanceof ApiError && e.status !== 500 ? e.message : fallback);

const STATUS: Record<ConnectorDetail['status'], { label: string; cls: string }> = {
  draft: { label: 'Not tested yet', cls: 'bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100' },
  connected: { label: 'Connected', cls: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100' },
  degraded: { label: 'Connected with warnings', cls: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100' },
  error: { label: 'Needs attention', cls: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100' },
  disconnected: { label: 'Disconnected', cls: 'bg-slate-200 text-slate-900 dark:bg-slate-700 dark:text-slate-100' },
};

export function StatusBadge({ status }: { status: ConnectorDetail['status'] }) {
  const s = STATUS[status];
  return <span className={`rounded px-2 py-0.5 text-sm font-medium ${s.cls}`}>{s.label}</span>;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`rounded px-2 py-0.5 text-sm ${enabled ? 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>
      {enabled ? 'In use' : 'Switched off'}
    </span>
  );
}

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

export const fieldClass = 'mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-600 dark:bg-slate-950';
export const buttonClass = 'rounded border border-slate-400 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800';
export const primaryButtonClass = 'rounded bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50';

export function Field({ id, label, children, hint }: { id: string; label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{hint}</p>}
    </div>
  );
}

/** Settings and credential inputs built from the provider descriptor, so a new connector type needs no new screen. */
export function DescriptorFields({
  provider,
  values,
  onChange,
  include,
  idPrefix = 'f',
}: {
  provider: ProviderView;
  values: Record<string, string>;
  onChange(name: string, value: string): void;
  include: { settings: boolean; credentials: boolean };
  idPrefix?: string;
}) {
  const method = provider.authMethods.find((m) => m.recommended) ?? provider.authMethods[0];
  return (
    <>
      {include.settings &&
        provider.configFields.map((f) => (
          <Field key={f.name} id={`${idPrefix}-${f.name}`} label={f.label}>
            <input
              id={`${idPrefix}-${f.name}`}
              type={f.type === 'url' ? 'url' : 'text'}
              required={f.required}
              className={fieldClass}
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
            />
          </Field>
        ))}
      {include.credentials && method && (
        <>
          {method.fields.map((f) => (
            <Field key={f.name} id={`${idPrefix}-${f.name}`} label={f.label} hint={`${method.label}. It is stored encrypted and is never shown again.`}>
              <input
                id={`${idPrefix}-${f.name}`}
                type="password"
                autoComplete="off"
                required={f.required}
                className={fieldClass}
                value={values[f.name] ?? ''}
                onChange={(e) => onChange(f.name, e.target.value)}
              />
            </Field>
          ))}
        </>
      )}
    </>
  );
}

export const SUPPORT_LABEL = { supported: 'Supported', partial: 'Partly supported', unsupported: 'Not supported' } as const;

export function CapabilityTable({ capabilities }: { capabilities: ConnectorDetail['capabilities'] }) {
  if (capabilities.length === 0) return <p className="text-sm">This connector type declares no capabilities.</p>;
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">What this connector can do</caption>
      <thead>
        <tr className="border-b border-slate-200 dark:border-slate-700">
          <th scope="col" className="py-2 pr-4">Capability</th>
          <th scope="col" className="py-2 pr-4">Support</th>
          <th scope="col" className="py-2 pr-4">Usable</th>
          <th scope="col" className="py-2">Note</th>
        </tr>
      </thead>
      <tbody>
        {capabilities.map((c) => (
          <tr key={c.capability} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
            <td className="py-2 pr-4 font-mono">{c.capability}</td>
            <td className="py-2 pr-4">{SUPPORT_LABEL[c.support]}</td>
            <td className="py-2 pr-4">{c.granted ? 'Yes' : 'No'}</td>
            <td className="py-2">{c.reason ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
