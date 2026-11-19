import { ConnectorDetailSchema, type ProviderView } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { Card, ErrorNotice, PageHeader } from '../common';
import { TestPanel } from './TestPanel';
import { DescriptorFields, Field, buttonClass, connectorKey, connectorsKey, errorText, fieldClass, primaryButtonClass, useProviders } from './shared';

const STEP_TITLES = { choose: 'Choose a system', details: 'Details', test: 'Test connection', review: 'Review' } as const;
type Step = keyof typeof STEP_TITLES;
const ORDER: Step[] = ['choose', 'details', 'test', 'review'];

export function ConnectorWizard() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const providers = useProviders();
  const [step, setStep] = useState<Step>('choose');
  const [providerKey, setProviderKey] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [createdId, setCreatedId] = useState<string | undefined>();
  const provider: ProviderView | undefined = providers.data?.items.find((p) => p.providerKey === providerKey);

  const create = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> = {};
      for (const f of provider!.configFields) if (values[f.name] !== undefined && values[f.name] !== '') config[f.name] = values[f.name];
      const secrets: Record<string, unknown> = {};
      for (const m of provider!.authMethods.slice(0, 1)) for (const f of m.fields) secrets[f.name] = values[f.name] ?? '';
      return api.post('/api/v1/connectors', { providerKey: provider!.providerKey, name, config, secrets: provider!.authMethods.length > 0 ? secrets : undefined }, ConnectorDetailSchema);
    },
    onSuccess: async (d) => {
      setCreatedId(d.id);
      setValues({});
      await qc.invalidateQueries({ queryKey: connectorsKey });
      setStep('test');
    },
  });

  const detail = useQuery({
    queryKey: connectorKey(createdId ?? 'none'),
    enabled: !!createdId,
    queryFn: () => api.get(`/api/v1/connectors/${createdId}`, ConnectorDetailSchema),
    refetchInterval: (q) => {
      const s = q.state.data?.latestTest?.status;
      return s === 'pending' || s === 'running' ? 1_500 : false;
    },
  });
  const enable = useMutation({
    mutationFn: () => api.post(`/api/v1/connectors/${createdId}/enable`, undefined, ConnectorDetailSchema),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: connectorsKey });
      await navigate({ to: '/connectors/$id', params: { id: createdId! } });
    },
  });

  return (
    <>
      <PageHeader title="Add connector" description="Pick a system, enter its details, and check the connection before anything is switched on." />
      <ol className="mb-4 flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {ORDER.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined} className={`rounded px-3 py-1 ${s === step ? 'bg-blue-100 font-medium text-blue-900 dark:bg-blue-950 dark:text-blue-100' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>
            {i + 1}. {STEP_TITLES[s]}
          </li>
        ))}
      </ol>

      {providers.isError && <ErrorNotice message="The list of connector types could not be loaded." onRetry={() => void providers.refetch()} />}

      {step === 'choose' && providers.data && (
        <Card label="Choose a system">
          <fieldset>
            <legend className="mb-2 font-medium">Which system do you want to connect?</legend>
            <div className="space-y-2">
              {providers.data.items.map((p) => (
                <label key={p.providerKey} className="flex cursor-pointer gap-3 rounded border border-slate-200 p-3 dark:border-slate-700">
                  <input type="radio" name="provider" checked={providerKey === p.providerKey} onChange={() => { setProviderKey(p.providerKey); setValues({}); }} />
                  <span>
                    <span className="block font-medium">{p.displayName}</span>
                    <span className="block text-sm text-slate-600 dark:text-slate-300">{p.description}</span>
                    {p.verification === 'fixtures-only' && <span className="block text-xs text-amber-800 dark:text-amber-200">Not verified against a live instance.</span>}
                    <span className="block text-xs text-slate-600 dark:text-slate-300">Needs: {p.requiredPermissions.join('; ')}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className={`${primaryButtonClass} mt-4`} disabled={!provider} onClick={() => setStep('details')}>Continue</button>
        </Card>
      )}

      {step === 'details' && provider && (
        <Card label="Details">
          <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <h2 className="text-lg font-semibold">{provider.displayName}</h2>
            <Field id="w-name" label="Name">
              <input id="w-name" required minLength={3} maxLength={80} className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <DescriptorFields provider={provider} values={values} onChange={(n, v) => setValues((s) => ({ ...s, [n]: v }))} include={{ settings: true, credentials: true }} idPrefix="w" />
            <div className="mt-4 flex gap-2">
              <button type="button" className={buttonClass} onClick={() => setStep('choose')}>Back</button>
              <button type="submit" className={primaryButtonClass} disabled={create.isPending}>Save and continue</button>
            </div>
            {create.isError && <div className="mt-3"><ErrorNotice message={errorText(create.error, 'The connector could not be saved.')} /></div>}
          </form>
        </Card>
      )}

      {step === 'test' && (
        <Card label="Test connection">
          {detail.data ? <TestPanel detail={detail.data} /> : <p role="status">Loading…</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" className={primaryButtonClass} disabled={!detail.data?.canEnable} onClick={() => setStep('review')}>Continue</button>
            {createdId && <Link to="/connectors/$id" params={{ id: createdId }} className={buttonClass}>Finish later</Link>}
          </div>
          {detail.data && !detail.data.canEnable && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Continue becomes available after a successful test.</p>}
        </Card>
      )}

      {step === 'review' && detail.data && (
        <Card label="Review">
          <h2 className="text-lg font-semibold">Review</h2>
          <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-medium">Name</dt><dd>{detail.data.name}</dd>
            <dt className="font-medium">Type</dt><dd>{detail.data.providerName}</dd>
            <dt className="font-medium">Access</dt><dd>{detail.data.accessMode === 'read_only' ? 'Read only' : detail.data.category === 'browser-automation' ? 'Can operate the browser' : 'Read and write'}</dd>
            <dt className="font-medium">Usable capabilities</dt><dd>{detail.data.capabilities.filter((c) => c.granted).length} of {detail.data.capabilities.length}</dd>
          </dl>
          <div className="mt-4 flex gap-2">
            <button type="button" className={buttonClass} onClick={() => setStep('test')}>Back</button>
            <button type="button" className={primaryButtonClass} disabled={enable.isPending} onClick={() => enable.mutate()}>Switch on</button>
          </div>
          {enable.isError && <div className="mt-3"><ErrorNotice message={errorText(enable.error, 'The connector could not be switched on.')} /></div>}
        </Card>
      )}
    </>
  );
}
