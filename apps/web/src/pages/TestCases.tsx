import {
  TestCaseListResponse, TestCaseSchema, TestCaseVersionList, TestCollectionListResponse, TestCollectionSchema,
} from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, buttonClass, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

const casesKey = ['test-cases'] as const;
const collectionsKey = ['test-collections'] as const;

export function TestCases() {
  const api = useApi();
  const session = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cases = useQuery({ queryKey: casesKey, queryFn: () => api.get('/api/v1/test-cases', TestCaseListResponse) });
  const collections = useQuery({ queryKey: collectionsKey, queryFn: () => api.get('/api/v1/test-collections', TestCollectionListResponse) });
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const canEdit = session.can('testcase.edit');
  const add = useMutation({
    mutationFn: () => api.post('/api/v1/test-cases', { name, summary, steps, expected }, TestCaseSchema),
    onSuccess: async (created) => {
      setName('');
      setSummary('');
      setSteps('');
      setExpected('');
      await qc.invalidateQueries({ queryKey: casesKey });
      await navigate({ to: '/test-cases/$id', params: { id: created.id } });
    },
  });
  const addCollection = useMutation({
    mutationFn: () => api.post('/api/v1/test-collections', { name: collectionName }, TestCollectionSchema),
    onSuccess: async (created) => {
      setCollectionName('');
      await qc.invalidateQueries({ queryKey: collectionsKey });
      await navigate({ to: '/test-collections/$id', params: { id: created.id } });
    },
  });
  return (
    <>
      <PageHeader title="Test Cases" description="Cases and collections kept in this platform. They are not written to Squash." />
      <div className="space-y-4">
        {canEdit && (
          <Card label="New test case">
            <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
              <Field id="case-name" label="Name"><input id="case-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field id="case-summary" label="Summary"><input id="case-summary" className={fieldClass} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
              <Field id="case-steps" label="Steps"><textarea id="case-steps" required rows={4} className={fieldClass} value={steps} onChange={(e) => setSteps(e.target.value)} /></Field>
              <Field id="case-expected" label="Expected result"><textarea id="case-expected" required rows={3} className={fieldClass} value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
              <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending}>Save test case</button>
              {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The test case could not be saved.')} /></div>}
            </form>
          </Card>
        )}
        <Card label="Test cases">
          {cases.isError && <ErrorNotice message="Test cases could not be loaded." onRetry={() => void cases.refetch()} />}
          {cases.data && cases.data.items.length === 0 && <p>No test cases yet.</p>}
          {cases.data && cases.data.items.length > 0 && (
            <ul className="space-y-2">
              {cases.data.items.map((item) => (
                <li key={item.id}>
                  <Link to="/test-cases/$id" params={{ id: item.id }} className="text-blue-700 underline dark:text-blue-300">{item.name}</Link>
                  {item.workItem ? ` · ${item.workItem}` : ''}
                  {' · version '}{item.version}
                  {item.summary ? ` · ${item.summary}` : ''}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {canEdit && (
          <Card label="New collection">
            <form onSubmit={(e) => { e.preventDefault(); addCollection.mutate(); }}>
              <Field id="collection-name" label="Name"><input id="collection-name" required className={fieldClass} value={collectionName} onChange={(e) => setCollectionName(e.target.value)} /></Field>
              <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={addCollection.isPending}>Save collection</button>
              {addCollection.isError && <div className="mt-3"><ErrorNotice message={errorText(addCollection.error, 'The collection could not be saved.')} /></div>}
            </form>
          </Card>
        )}
        <Card label="Collections">
          {collections.isError && <ErrorNotice message="Collections could not be loaded." onRetry={() => void collections.refetch()} />}
          {collections.data && collections.data.items.length === 0 && <p>No collections yet.</p>}
          {collections.data && collections.data.items.length > 0 && (
            <ul className="space-y-2">
              {collections.data.items.map((item) => (
                <li key={item.id}>
                  <Link to="/test-collections/$id" params={{ id: item.id }} className="text-blue-700 underline dark:text-blue-300">{item.name}</Link>
                  {' · '}{item.size} {item.size === 1 ? 'case' : 'cases'}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export function TestCasePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const session = useSession();
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
  return (
    <>
      <PageHeader title={item.data?.name ?? 'Test case'} description={item.data ? `Version ${item.data.version}. Older versions stay as they were.` : 'Loading the test case.'} />
      <p className="mb-4"><Link to="/test-cases" className="text-blue-700 underline dark:text-blue-300">Back to test cases</Link></p>
      {item.isError && <ErrorNotice message={errorText(item.error, 'The test case could not be loaded.')} onRetry={() => void item.refetch()} />}
      {item.data && (
        <div className="space-y-4">
          <Card label="Current version">
            {session.can('testcase.edit') ? (
              <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
                <Field id="revise-summary" label="Summary"><input id="revise-summary" className={fieldClass} value={summary ?? item.data.summary} onChange={(e) => setSummary(e.target.value)} /></Field>
                <Field id="revise-steps" label="Steps"><textarea id="revise-steps" required rows={4} className={fieldClass} value={steps ?? item.data.steps} onChange={(e) => setSteps(e.target.value)} /></Field>
                <Field id="revise-expected" label="Expected result"><textarea id="revise-expected" required rows={3} className={fieldClass} value={expected ?? item.data.expected} onChange={(e) => setExpected(e.target.value)} /></Field>
                <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={save.isPending}>Save</button>
                {save.isError && <div className="mt-3"><ErrorNotice message={errorText(save.error, 'The version could not be saved.')} /></div>}
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
  const chosen = new Set(collection.data?.cases.map((c) => c.id) ?? []);
  const available = (cases.data?.items ?? []).filter((item) => !chosen.has(item.id));
  return (
    <>
      <PageHeader title={collection.data?.name ?? 'Collection'} description="A named set of test cases a regression run can refer to later." />
      <p className="mb-4"><Link to="/test-cases" className="text-blue-700 underline dark:text-blue-300">Back to test cases</Link></p>
      {collection.isError && <ErrorNotice message={errorText(collection.error, 'The collection could not be loaded.')} onRetry={() => void collection.refetch()} />}
      {collection.data && (
        <Card label="Cases">
          {collection.data.cases.length === 0 && <p>This collection has no cases yet.</p>}
          <ul className="space-y-2">
            {collection.data.cases.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2">
                <Link to="/test-cases/$id" params={{ id: item.id }} className="text-blue-700 underline dark:text-blue-300">{item.name}</Link>
                <span>version {item.version}</span>
                {session.can('testcase.edit') && <button type="button" className={buttonClass} onClick={() => remove.mutate(item.id)}>Remove</button>}
              </li>
            ))}
          </ul>
          {session.can('testcase.edit') && available.length > 0 && (
            <form className="mt-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
              <Field id="add-case" label="Add a case">
                <select id="add-case" required className={fieldClass} value={caseId} onChange={(e) => setCaseId(e.target.value)}>
                  <option value="">Choose a test case</option>
                  {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </Field>
              <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending || !caseId}>Add to collection</button>
              {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The case could not be added.')} /></div>}
            </form>
          )}
          {remove.isError && <div className="mt-3"><ErrorNotice message={errorText(remove.error, 'The case could not be removed.')} /></div>}
        </Card>
      )}
    </>
  );
}
