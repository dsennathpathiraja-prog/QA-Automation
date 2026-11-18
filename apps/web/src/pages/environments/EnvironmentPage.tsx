import {
  AuthProfileListResponse,
  AuthProfileSchema,
  AuthorizationListResponse,
  AuthorizationSchema,
  ConnectorListResponse,
  ConnectorRefListResponse,
  ConnectorRefSchema,
  EnvironmentDetailSchema,
  EnvironmentValidationSchema,
  TestDataListResponse,
  TestDataProfileSchema,
  type EnvironmentDetail,
} from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useSession } from '../../auth/session';
import { Card, ErrorNotice, PageHeader } from '../common';
import { Field, buttonClass, errorText, fieldClass, primaryButtonClass } from '../connectors/shared';
import { environmentsKey, kindLabel } from '../Environments';

type Tab = 'general' | 'browser' | 'data' | 'auth' | 'connectors' | 'restrictions';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'browser', label: 'Browser' },
  { id: 'data', label: 'Test data' },
  { id: 'auth', label: 'Authentication' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'restrictions', label: 'Restrictions' },
];

export function EnvironmentPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const api = useApi();
  const q = useQuery({ queryKey: ['environment', id], queryFn: () => api.get(`/api/v1/environments/${id}`, EnvironmentDetailSchema) });
  if (q.isError) return (
    <>
      <PageHeader title="Environment" />
      <ErrorNotice message={errorText(q.error, 'The environment could not be loaded.')} onRetry={() => void q.refetch()} />
      <p className="mt-3"><Link to="/environments" className="text-blue-700 underline dark:text-blue-300">Back to environments</Link></p>
    </>
  );
  if (!q.data) return <p role="status">Loading environment…</p>;
  return <Detail env={q.data} />;
}

function Detail({ env }: { env: EnvironmentDetail }) {
  const [tab, setTab] = useState<Tab>('general');
  return (
    <>
      <PageHeader title={env.name} description={`${kindLabel(env.kind)} · ${env.selectable ? 'Selectable for a run' : env.kind === 'production' ? 'Not selectable until an authorization is active' : 'Not selectable'}`} />
      <p className="mb-4 text-sm">Reachability has not been checked yet. That check waits until a runner can place it.</p>
      <div role="tablist" aria-label="Environment settings" className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? primaryButtonClass : buttonClass} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'general' && <General env={env} />}
      {tab === 'browser' && <Browser env={env} />}
      {tab === 'data' && <TestData envId={env.id} />}
      {tab === 'auth' && <Authentication envId={env.id} />}
      {tab === 'connectors' && <Connectors envId={env.id} />}
      {tab === 'restrictions' && <Restrictions env={env} />}
    </>
  );
}

function General({ env }: { env: EnvironmentDetail }) {
  const api = useApi();
  const manage = useSession().can('environment.manage');
  const qc = useQueryClient();
  const [name, setName] = useState(env.name);
  const [applicationUrl, setApplicationUrl] = useState(env.applicationUrl);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/environments/${env.id}`, { name, applicationUrl }, EnvironmentDetailSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environment', env.id] }),
  });
  const toggle = useMutation({
    mutationFn: () => api.post(`/api/v1/environments/${env.id}/${env.enabled ? 'disable' : 'enable'}`, {}, EnvironmentDetailSchema),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['environment', env.id] });
      void qc.invalidateQueries({ queryKey: environmentsKey });
    },
  });
  return (
    <Card label="General">
      <p className="font-mono text-sm">{env.applicationUrl}</p>
      {manage ? (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <Field id="g-name" label="Name"><input id="g-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field id="g-url" label="Application URL"><input id="g-url" required type="url" className={fieldClass} value={applicationUrl} onChange={(e) => setApplicationUrl(e.target.value)} /></Field>
          <div className="mt-3 flex gap-2">
            <button type="submit" className={primaryButtonClass}>Save general settings</button>
            <button type="button" className={buttonClass} onClick={() => toggle.mutate()}>{env.enabled ? 'Disable' : 'Enable'}</button>
          </div>
          {(save.isError || toggle.isError) && <div className="mt-3"><ErrorNotice message={errorText(save.error ?? toggle.error, 'The environment could not be saved.')} /></div>}
        </form>
      ) : <p className="mt-2 text-sm">You can view this environment. An Administrator changes it.</p>}
    </Card>
  );
}

function Browser({ env }: { env: EnvironmentDetail }) {
  const api = useApi();
  const manage = useSession().can('environment.manage');
  const qc = useQueryClient();
  const [browser, setBrowser] = useState(env.browser.browser);
  const [headless, setHeadless] = useState(env.browser.headless);
  const [width, setWidth] = useState(String(env.browser.viewport?.width ?? 1280));
  const [height, setHeight] = useState(String(env.browser.viewport?.height ?? 720));
  const save = useMutation({
    mutationFn: () => api.patch(`/api/v1/environments/${env.id}`, { browser: { browser, headless, viewport: { width: Number(width), height: Number(height) } } }, EnvironmentDetailSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environment', env.id] }),
  });
  if (!manage) return <Card label="Browser"><p>{env.browser.browser}, {env.browser.headless ? 'headless' : 'headed'}</p></Card>;
  return (
    <Card label="Browser">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field id="b-browser" label="Browser">
          <select id="b-browser" className={fieldClass} value={browser} onChange={(e) => setBrowser(e.target.value as typeof browser)}>
            <option value="chromium">Chromium</option>
            <option value="firefox">Firefox</option>
            <option value="webkit">WebKit</option>
          </select>
        </Field>
        <Field id="b-width" label="Viewport width"><input id="b-width" required className={fieldClass} value={width} onChange={(e) => setWidth(e.target.value)} /></Field>
        <Field id="b-height" label="Viewport height"><input id="b-height" required className={fieldClass} value={height} onChange={(e) => setHeight(e.target.value)} /></Field>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} /> Headless</label>
        <button type="submit" className={`${primaryButtonClass} mt-3`}>Save browser settings</button>
        {save.isError && <div className="mt-3"><ErrorNotice message={errorText(save.error, 'The browser settings could not be saved.')} /></div>}
      </form>
    </Card>
  );
}

function TestData({ envId }: { envId: string }) {
  const api = useApi();
  const manage = useSession().can('environment.manage');
  const q = useQuery({ queryKey: ['environment', envId, 'data'], queryFn: () => api.get(`/api/v1/environments/${envId}/test-data`, TestDataListResponse) });
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [keyName, setKeyName] = useState('customer');
  const [value, setValue] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const add = useMutation({
    mutationFn: () => api.post(`/api/v1/environments/${envId}/test-data`, { name, data: value ? { [keyName]: value } : {}, secrets: secretKey && secretValue ? { [secretKey]: secretValue } : undefined }, TestDataProfileSchema),
    onSuccess: async () => {
      setSecretValue('');
      await qc.invalidateQueries({ queryKey: ['environment', envId, 'data'] });
    },
  });
  return (
    <Card label="Test data">
      {q.isError && <ErrorNotice message="Test data could not be loaded." onRetry={() => void q.refetch()} />}
      {q.data?.items.map((p) => <p key={p.id} className="text-sm">{p.name}{p.hasSecret ? ' · secret saved' : ''}</p>)}
      {q.data?.items.length === 0 && <p className="text-sm">No test data profiles yet.</p>}
      {manage && (
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field id="td-name" label="Profile name"><input id="td-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field id="td-key" label="Data name"><input id="td-key" className={fieldClass} value={keyName} onChange={(e) => setKeyName(e.target.value)} /></Field>
          <Field id="td-value" label="Data value"><input id="td-value" className={fieldClass} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          <Field id="td-secret-key" label="Secret name" hint="Optional. The value is stored encrypted and is never shown again."><input id="td-secret-key" className={fieldClass} value={secretKey} onChange={(e) => setSecretKey(e.target.value)} /></Field>
          <Field id="td-secret" label="Secret value"><input id="td-secret" type="password" autoComplete="off" className={fieldClass} value={secretValue} onChange={(e) => setSecretValue(e.target.value)} /></Field>
          <button type="submit" className={`${primaryButtonClass} mt-3`}>Add test data</button>
          {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The test data could not be saved.')} /></div>}
        </form>
      )}
    </Card>
  );
}

function Authentication({ envId }: { envId: string }) {
  const api = useApi();
  const manage = useSession().can('environment.manage');
  const q = useQuery({ queryKey: ['environment', envId, 'auth'], queryFn: () => api.get(`/api/v1/environments/${envId}/auth-profiles`, AuthProfileListResponse) });
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'none' | 'basic' | 'form-login' | 'bearer' | 'storage-state'>('form-login');
  const [username, setUsername] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [secret, setSecret] = useState('');
  const add = useMutation({
    mutationFn: () => {
      const config: Record<string, string> = {};
      if (type === 'basic' || type === 'form-login') config.username = username;
      if (type === 'form-login') config.loginUrl = loginUrl;
      const key = type === 'bearer' ? 'token' : type === 'storage-state' ? 'storageState' : 'password';
      return api.post(`/api/v1/environments/${envId}/auth-profiles`, { name, type, config, secrets: type === 'none' ? undefined : { [key]: secret } }, AuthProfileSchema);
    },
    onSuccess: async () => {
      setSecret('');
      await qc.invalidateQueries({ queryKey: ['environment', envId, 'auth'] });
    },
  });
  return (
    <Card label="Authentication">
      {q.isError && <ErrorNotice message="Authentication profiles could not be loaded." onRetry={() => void q.refetch()} />}
      {q.data?.items.map((p) => <ProfileRow key={p.id} profile={p} />)}
      {q.data?.items.length === 0 && <p className="text-sm">No authentication profiles yet.</p>}
      {manage && (
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field id="a-name" label="Profile name"><input id="a-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field id="a-type" label="Type">
            <select id="a-type" className={fieldClass} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="none">None</option>
              <option value="basic">Basic</option>
              <option value="form-login">Form login</option>
              <option value="bearer">Bearer token</option>
              <option value="storage-state">Saved browser session</option>
            </select>
          </Field>
          {(type === 'basic' || type === 'form-login') && <Field id="a-user" label="Username"><input id="a-user" required className={fieldClass} value={username} onChange={(e) => setUsername(e.target.value)} /></Field>}
          {type === 'form-login' && <Field id="a-login" label="Login URL"><input id="a-login" required type="url" className={fieldClass} value={loginUrl} onChange={(e) => setLoginUrl(e.target.value)} /></Field>}
          {type !== 'none' && <Field id="a-secret" label={type === 'bearer' ? 'Token' : type === 'storage-state' ? 'Saved session' : 'Password'} hint="Stored encrypted. After saving, the field stays empty and shows that a value is on file."><input id="a-secret" type="password" autoComplete="new-password" required className={fieldClass} value={secret} onChange={(e) => setSecret(e.target.value)} /></Field>}
          <button type="submit" className={`${primaryButtonClass} mt-3`}>Save authentication</button>
          {add.isError && <div className="mt-3"><ErrorNotice message={errorText(add.error, 'The authentication profile could not be saved.')} /></div>}
        </form>
      )}
    </Card>
  );
}

function ProfileRow({ profile }: { profile: { id: string; name: string; type: string; config: Record<string, string>; hasSecret: boolean } }) {
  return <p className="text-sm">{profile.name} · {profile.type}{profile.config.username ? ` · ${profile.config.username}` : ''}{profile.hasSecret ? ' · •••••••• saved' : ''}</p>;
}

function Connectors({ envId }: { envId: string }) {
  const api = useApi();
  const manage = useSession().can('environment.manage');
  const refs = useQuery({ queryKey: ['environment', envId, 'connectors'], queryFn: () => api.get(`/api/v1/environments/${envId}/connectors`, ConnectorRefListResponse) });
  const all = useQuery({ queryKey: ['connectors'], queryFn: () => api.get('/api/v1/connectors', ConnectorListResponse), enabled: manage });
  const qc = useQueryClient();
  const roles = ['work-item', 'source-repo', 'test-management', 'browser-automation'] as const;
  const [choice, setChoice] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async (role: (typeof roles)[number]) => {
      const connectorId = choice[role] ?? '';
      if (!connectorId) {
        await api.delete(`/api/v1/environments/${envId}/connectors/${role}`);
        return;
      }
      await api.put(`/api/v1/environments/${envId}/connectors`, { role, connectorId }, ConnectorRefSchema);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environment', envId, 'connectors'] }),
  });
  return (
    <Card label="Connectors">
      {refs.isError && <ErrorNotice message="Connector references could not be loaded." onRetry={() => void refs.refetch()} />}
      {roles.map((role) => {
        const current = refs.data?.items.find((r) => r.role === role);
        const options = (all.data?.items ?? []).filter((c) => c.category === role && c.enabled);
        return (
          <div key={role} className="mt-3">
            <p className="text-sm font-medium">{role}</p>
            <p className="text-sm">{current ? current.connectorName : 'None attached'}</p>
            {manage && (
              <div className="mt-1 flex gap-2">
                <select aria-label={role} className={fieldClass} value={choice[role] ?? current?.connectorInstanceId ?? ''} onChange={(e) => setChoice({ ...choice, [role]: e.target.value })}>
                  <option value="">None</option>
                  {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <button type="button" className={buttonClass} onClick={() => save.mutate(role)}>Save</button>
              </div>
            )}
          </div>
        );
      })}
      {save.isError && <div className="mt-3"><ErrorNotice message={errorText(save.error, 'The connector could not be attached.')} /></div>}
    </Card>
  );
}

function Restrictions({ env }: { env: EnvironmentDetail }) {
  const api = useApi();
  const session = useSession();
  const auths = useQuery({ queryKey: ['environment', env.id, 'authz'], queryFn: () => api.get(`/api/v1/environments/${env.id}/authorizations`, AuthorizationListResponse), enabled: env.kind === 'production' });
  const check = useMutation({ mutationFn: () => api.post(`/api/v1/environments/${env.id}/validate`, {}, EnvironmentValidationSchema) });
  const [justification, setJustification] = useState('');
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const qc = useQueryClient();
  const grant = useMutation({
    mutationFn: () => api.post(`/api/v1/environments/${env.id}/authorizations`, { justification, validFrom: new Date(validFrom).toISOString(), validUntil: new Date(validUntil).toISOString() }, AuthorizationSchema),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['environment', env.id] });
      await qc.invalidateQueries({ queryKey: ['environment', env.id, 'authz'] });
    },
  });
  return (
    <Card label="Restrictions">
      <p className="text-sm">Parallel runs: {env.restrictions.maxParallelism}. {env.restrictions.prodSafeOnly ? 'Prod-safe cases only.' : 'Prod-safe restriction is off.'}</p>
      {env.restrictions.workflowTypes && <p className="text-sm">Workflows: {env.restrictions.workflowTypes.join(', ')}</p>}
      <button type="button" className={`${buttonClass} mt-3`} onClick={() => check.mutate()}>Check this environment</button>
      {check.data && (
        <div className="mt-3" role="status">
          {check.data.ok ? <p>This environment is ready to select. Reachability has not been checked.</p> : (
            <ul className="list-disc pl-5 text-sm">{check.data.errors.map((e) => <li key={e.message}>{e.message}</li>)}</ul>
          )}
        </div>
      )}
      {check.isError && <div className="mt-3"><ErrorNotice message={errorText(check.error, 'The environment could not be checked.')} /></div>}
      {env.kind === 'production' && (
        <div className="mt-4">
          <h2 className="text-base font-medium">Production authorization</h2>
          {auths.data?.items.map((a) => <p key={a.id} className="mt-1 text-sm">{a.active ? 'Authorized' : a.status} until {a.validUntil.slice(0, 10)} ({a.grantedByName}). {a.justification}</p>)}
          {session.can('environment.production.authorize') && (
            <form onSubmit={(e) => { e.preventDefault(); grant.mutate(); }}>
              <Field id="auth-why" label="Why production runs are allowed"><textarea id="auth-why" required className={fieldClass} value={justification} onChange={(e) => setJustification(e.target.value)} /></Field>
              <Field id="auth-from" label="Valid from"><input id="auth-from" required type="date" className={fieldClass} value={validFrom} onChange={(e) => setValidFrom(e.target.value)} /></Field>
              <Field id="auth-until" label="Valid until"><input id="auth-until" required type="date" className={fieldClass} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
              <button type="submit" className={`${primaryButtonClass} mt-3`}>Grant authorization</button>
              {grant.isError && <div className="mt-3"><ErrorNotice message={errorText(grant.error, 'The authorization could not be granted.')} /></div>}
            </form>
          )}
        </div>
      )}
    </Card>
  );
}
