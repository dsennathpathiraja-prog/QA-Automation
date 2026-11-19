import {
  ResetTestCasesResponse,
  TestCaseListResponse,
  TestCaseSchema,
  TestCaseVersionList,
  TestCollectionListResponse,
  TestCollectionSchema,
} from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, buttonClass, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

const casesKey = ['test-cases'] as const;
const collectionsKey = ['test-collections'] as const;

type CaseKind = 'positive' | 'negative' | 'edge';
type CasePriority = 'high' | 'medium' | 'low';

const KIND_ORDER: CaseKind[] = ['positive', 'negative', 'edge'];
const KIND_LABEL: Record<CaseKind, string> = {
  positive: 'Positive',
  negative: 'Negative',
  edge: 'Edge',
};
const PRIORITY_LABEL: Record<CasePriority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function KindBadge({ kind }: { kind: CaseKind }) {
  const tone =
    kind === 'negative'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100'
      : kind === 'edge'
        ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100'
        : 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100';
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{KIND_LABEL[kind]}</span>;
}

function PriorityBadge({ priority }: { priority: CasePriority }) {
  return (
    <span className="inline-block rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 dark:border-slate-600 dark:text-slate-200">
      {PRIORITY_LABEL[priority]} priority
    </span>
  );
}

export function TestCases() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const collections = useQuery({ queryKey: collectionsKey, queryFn: () => api.get('/api/v1/test-collections', TestCollectionListResponse) });
  const deleteCollection = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/test-collections/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: casesKey });
      await qc.invalidateQueries({ queryKey: collectionsKey });
    },
  });
  const reset = useMutation({
    mutationFn: () => api.post('/api/v1/test-cases/reset', { confirm: 'RESET_PLATFORM_CASES' }, ResetTestCasesResponse),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: casesKey });
      await qc.invalidateQueries({ queryKey: collectionsKey });
    },
  });
  const canEdit = session.can('testcase.edit');
  const items = collections.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Test Cases"
        description="Collections group the cases a requirement-validation run stored for each work item. Open a collection to see positive, negative, and edge cases with priority."
      />
      <div className="space-y-4">
        {canEdit && (
          <Card label="Clear platform data">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Soft-delete every platform collection and case so you can start fresh. Squash copies are not removed.
            </p>
            <button
              type="button"
              className={`${buttonClass} mt-3`}
              disabled={reset.isPending || items.length === 0}
              onClick={() => {
                if (window.confirm('Clear all platform test cases and collections? Squash copies stay. This cannot be undone from the UI.')) {
                  reset.mutate();
                }
              }}
            >
              Clear platform test cases
            </button>
            {reset.isSuccess && (
              <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">
                Cleared {reset.data.collectionsCleared} collection{reset.data.collectionsCleared === 1 ? '' : 's'} and {reset.data.casesCleared} case{reset.data.casesCleared === 1 ? '' : 's'}.
              </p>
            )}
            {reset.isError && <div className="mt-3"><ErrorNotice message={errorText(reset.error, 'Platform test cases could not be cleared.')} /></div>}
          </Card>
        )}
        <Card label="Collections">
          {collections.isError && <ErrorNotice message="Collections could not be loaded." onRetry={() => void collections.refetch()} />}
          {collections.data && items.length === 0 && (
            <p>No collections yet. Run a requirement-validation workflow; generated cases appear here under the work item name.</p>
          )}
          {items.length > 0 && (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <Link to="/test-collections/$id" params={{ id: item.id }} className="text-lg font-medium text-blue-700 underline dark:text-blue-300">
                      {item.name}
                    </Link>
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                      {item.size} {item.size === 1 ? 'case' : 'cases'}
                      {item.description ? ` · ${item.description}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to="/test-collections/$id" params={{ id: item.id }} className={buttonClass}>
                      Open
                    </Link>
                    {canEdit && (
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={deleteCollection.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete collection ${item.name} and its platform cases? Squash copies stay.`)) {
                            deleteCollection.mutate(item.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {deleteCollection.isError && <div className="mt-3"><ErrorNotice message={errorText(deleteCollection.error, 'The collection could not be deleted.')} /></div>}
        </Card>
      </div>
    </>
  );
}

export function TestCasePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const item = useQuery({ queryKey: ['test-case', id], queryFn: () => api.get(`/api/v1/test-cases/${id}`, TestCaseSchema) });
  const versions = useQuery({ queryKey: ['test-case', id, 'versions'], queryFn: () => api.get(`/api/v1/test-cases/${id}/versions`, TestCaseVersionList) });
  const [summary, setSummary] = useState<string | null>(null);
  const [steps, setSteps] = useState<string | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.put(`/api/v1/test-cases/${id}`, { summary: summary ?? item.data?.summary ?? '', steps: steps ?? item.data?.steps ?? '', expected: expected ?? item.data?.expected ?? '' }, TestCaseSchema),
    onSuccess: async () => {
      setSummary(null);
      setSteps(null);
      setExpected(null);
      await qc.invalidateQueries({ queryKey: ['test-case', id] });
      await qc.invalidateQueries({ queryKey: casesKey });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/v1/test-cases/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: casesKey });
      await qc.invalidateQueries({ queryKey: collectionsKey });
      await navigate({ to: '/test-cases' });
    },
  });
  return (
    <>
      <PageHeader title={item.data?.name ?? 'Test case'} description={item.data ? `Version ${item.data.version}. Older versions stay as they were.` : 'Loading the test case.'} />
      <p className="mb-4"><Link to="/test-cases" className="text-blue-700 underline dark:text-blue-300">Back to test cases</Link></p>
      {item.isError && <ErrorNotice message={errorText(item.error, 'The test case could not be loaded.')} onRetry={() => void item.refetch()} />}
      {item.data && (
        <div className="space-y-4">
          <Card label="Current version">
            <div className="mb-3 flex flex-wrap gap-2">
              <KindBadge kind={item.data.kind} />
              <PriorityBadge priority={item.data.priority} />
              {item.data.workItem && <span className="text-sm text-slate-600 dark:text-slate-300">Work item {item.data.workItem}</span>}
            </div>
            {session.can('testcase.edit') ? (
              <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                <Field id="revise-summary" label="Summary"><input id="revise-summary" className={fieldClass} value={summary ?? item.data.summary} onChange={(e) => setSummary(e.target.value)} /></Field>
                <Field id="revise-steps" label="Steps"><textarea id="revise-steps" required rows={4} className={fieldClass} value={steps ?? item.data.steps} onChange={(e) => setSteps(e.target.value)} /></Field>
                <Field id="revise-expected" label="Expected result"><textarea id="revise-expected" required rows={3} className={fieldClass} value={expected ?? item.data.expected} onChange={(e) => setExpected(e.target.value)} /></Field>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="submit" className={primaryButtonClass} disabled={save.isPending}>Save</button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm('Delete this test case from the platform? Squash copies stay.')) remove.mutate();
                    }}
                  >
                    Delete test case
                  </button>
                </div>
                {save.isError && <div className="mt-3"><ErrorNotice message={errorText(save.error, 'The version could not be saved.')} /></div>}
                {remove.isError && <div className="mt-3"><ErrorNotice message={errorText(remove.error, 'The test case could not be deleted.')} /></div>}
              </form>
            ) : (
              <>
                {item.data.summary && <p>{item.data.summary}</p>}
                <p className="mt-3 whitespace-pre-wrap">{item.data.steps}</p>
                <p className="mt-3 whitespace-pre-wrap">{item.data.expected}</p>
              </>
            )}
          </Card>
          <Card label="Versions">
            {versions.isError && <ErrorNotice message="Versions could not be loaded." onRetry={() => void versions.refetch()} />}
            <ul className="space-y-3">
              {versions.data?.items.map((version) => (
                <li key={version.version}>
                  <p>Version {version.version}{version.version === item.data?.version ? ' · current' : ''}</p>
                  <p className="whitespace-pre-wrap text-slate-700 dark:text-slate-200">{version.steps}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

export function TestCollectionPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const collection = useQuery({ queryKey: ['test-collection', id], queryFn: () => api.get(`/api/v1/test-collections/${id}`, TestCollectionSchema) });
  const cases = useQuery({ queryKey: casesKey, queryFn: () => api.get('/api/v1/test-cases', TestCaseListResponse), enabled: session.can('testcase.edit') });
  const [caseId, setCaseId] = useState('');
  const add = useMutation({
    mutationFn: () => api.post(`/api/v1/test-collections/${id}/cases`, { testCaseId: caseId }, TestCollectionSchema),
    onSuccess: async () => {
      setCaseId('');
      await qc.invalidateQueries({ queryKey: ['test-collection', id] });
      await qc.invalidateQueries({ queryKey: collectionsKey });
    },
  });
  const remove = useMutation({
    mutationFn: (testCaseId: string) => api.delete(`/api/v1/test-collections/${id}/cases/${testCaseId}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['test-collection', id] });
      await qc.invalidateQueries({ queryKey: collectionsKey });
    },
  });
  const deleteCollection = useMutation({
    mutationFn: () => api.delete(`/api/v1/test-collections/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: casesKey });
      await qc.invalidateQueries({ queryKey: collectionsKey });
      await navigate({ to: '/test-cases' });
    },
  });
  const chosen = new Set(collection.data?.cases.map((c) => c.id) ?? []);
  const available = (cases.data?.items ?? []).filter((item) => !chosen.has(item.id));
  const grouped = useMemo(() => {
    const map = new Map<CaseKind, NonNullable<typeof collection.data>['cases']>();
    for (const kind of KIND_ORDER) map.set(kind, []);
    for (const item of collection.data?.cases ?? []) {
      const list = map.get(item.kind) ?? [];
      list.push(item);
      map.set(item.kind, list);
    }
    for (const kind of KIND_ORDER) {
      map.get(kind)?.sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 };
        return rank[a.priority] - rank[b.priority] || a.position - b.position;
      });
    }
    return map;
  }, [collection.data?.cases]);
  return (
    <>
      <PageHeader
        title={collection.data?.name ?? 'Collection'}
        description="Cases for this work item, grouped by kind. Deleting the collection removes its platform cases; Squash copies stay."
      />
      <p className="mb-4"><Link to="/test-cases" className="text-blue-700 underline dark:text-blue-300">Back to collections</Link></p>
      {collection.isError && <ErrorNotice message={errorText(collection.error, 'The collection could not be loaded.')} onRetry={() => void collection.refetch()} />}
      {collection.data && (
        <div className="space-y-4">
          {session.can('testcase.edit') && (
            <Card label="Collection actions">
              <button
                type="button"
                className={buttonClass}
                disabled={deleteCollection.isPending}
                onClick={() => {
                  if (window.confirm(`Delete collection ${collection.data.name} and its platform cases? Squash copies stay.`)) {
                    deleteCollection.mutate();
                  }
                }}
              >
                Delete collection
              </button>
              {deleteCollection.isError && <div className="mt-3"><ErrorNotice message={errorText(deleteCollection.error, 'The collection could not be deleted.')} /></div>}
            </Card>
          )}
          {collection.data.cases.length === 0 && (
            <Card label="Cases">
              <p>This collection has no cases yet.</p>
            </Card>
          )}
          {KIND_ORDER.map((kind) => {
            const group = grouped.get(kind) ?? [];
            if (group.length === 0) return null;
            return (
              <Card key={kind} label={KIND_LABEL[kind]}>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-medium">{KIND_LABEL[kind]} cases</h2>
                  <span className="text-sm text-slate-600 dark:text-slate-300">{group.length}</span>
                </div>
                <ul className="space-y-3">
                  {group.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 border-t border-slate-100 pt-3 first:border-t-0 first:pt-0 dark:border-slate-800">
                      <div className="min-w-0">
                        <Link to="/test-cases/$id" params={{ id: item.id }} className="font-medium text-blue-700 underline dark:text-blue-300">
                          {item.name}
                        </Link>
                        <div className="mt-1 flex flex-wrap gap-2">
                          <KindBadge kind={item.kind} />
                          <PriorityBadge priority={item.priority} />
                          <span className="text-sm text-slate-600 dark:text-slate-300">version {item.version}</span>
                        </div>
                      </div>
                      {session.can('testcase.edit') && (
                        <button type="button" className={buttonClass} onClick={() => remove.mutate(item.id)}>Remove</button>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
          {session.can('testcase.edit') && available.length > 0 && (
            <Card label="Add a case">
              <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
                <Field id="add-case" label="Add a case">
                  <select id="add-case" required className={fieldClass} value={caseId} onChange={(e) => setCaseId(e.target.value)}>
                    <option value="">Choose a test case</option>
                    {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </Field>
                <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending || !caseId}>Add to collection</button>
                {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The case could not be added.')} /></div>}
              </form>
            </Card>
          )}
          {remove.isError && <div className="mt-3"><ErrorNotice message={errorText(remove.error, 'The case could not be removed.')} /></div>}
        </div>
      )}
    </>
  );
}
