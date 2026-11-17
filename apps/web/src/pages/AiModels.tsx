import { LlmProvidersResponse } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../api/context';
import { Card, ErrorNotice, PageHeader } from './common';

const yesNo = (v: boolean | undefined) => (v === undefined ? 'Unknown' : v ? 'Yes' : 'No');

export function AiModels() {
  const api = useApi();
  const q = useQuery({ queryKey: ['llm-providers'], queryFn: () => api.get('/api/v1/llm/providers', LlmProvidersResponse) });
  return (
    <>
      <PageHeader
        title="AI Models"
        description="Model providers the platform can use. Models run inside your network by default; external providers stay disabled unless two Administrators approve them."
      />
      {q.isError && <ErrorNotice message="The provider list could not be loaded." onRetry={() => void q.refetch()} />}
      {q.isPending && <p role="status">Checking providers…</p>}
      {q.data && q.data.items.length === 0 && (
        <Card label="No providers">
          <p>No model provider is configured yet.</p>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            Set the address of your local Ollama or vLLM server in the deployment settings. Choosing which model each agent uses arrives in Phase 5.
          </p>
        </Card>
      )}
      <div className="space-y-4">
        {q.data?.items.map((p) => (
          <Card key={p.id} label={`Provider ${p.id}`}>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold">{p.id}</h2>
              <span className="text-sm text-slate-600 dark:text-slate-300">{p.adapter} · {p.kind === 'local' ? 'runs in your network' : 'external'}</span>
              <span
                className={`rounded px-2 py-0.5 text-sm font-medium ${p.health.ok ? 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100' : 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100'}`}
              >
                {p.health.ok ? `Reachable (${p.health.latencyMs} ms)` : `Unreachable${p.health.detail ? `: ${p.health.detail}` : ''}`}
              </span>
            </div>
            {p.models.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">{p.health.ok ? 'No models are installed on this provider.' : 'Models cannot be listed while the provider is unreachable.'}</p>
            ) : (
              <table className="mt-3 w-full text-left text-sm">
                <caption className="sr-only">Models on {p.id}</caption>
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th scope="col" className="py-2 pr-4">Model</th>
                    <th scope="col" className="py-2 pr-4">Context window</th>
                    <th scope="col" className="py-2 pr-4">Tool calling</th>
                    <th scope="col" className="py-2 pr-4">Structured output</th>
                    <th scope="col" className="py-2">Images</th>
                  </tr>
                </thead>
                <tbody>
                  {p.models.map((m) => (
                    <tr key={m.name} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="py-2 pr-4 font-mono">{m.name}</td>
                      <td className="py-2 pr-4">{m.contextTokens ? `${m.contextTokens.toLocaleString('en-US')} tokens` : 'Unknown'}</td>
                      <td className="py-2 pr-4">{yesNo(m.supportsToolCalling)}</td>
                      <td className="py-2 pr-4">{yesNo(m.supportsStructuredOutput)}</td>
                      <td className="py-2">{yesNo(m.supportsVision)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
