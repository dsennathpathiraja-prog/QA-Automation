// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { meFor, renderApp } from './harness';

afterEach(cleanup);

const provider = {
  providerKey: 'sample-work-items',
  category: 'work-item',
  displayName: 'Sample work items (demo)',
  description: 'Built-in demo source.',
  requiresInternet: false,
  requiredPermissions: ['None. This is a built-in demo.'],
  configFields: [{ name: 'projectName', label: 'Demo project name', type: 'text', required: true }],
  authMethods: [{ key: 'demo_key', label: 'Demo key', recommended: true, fields: [{ name: 'demoKey', label: 'Demo key', type: 'secret', required: true }] }],
  capabilities: [{ id: 'workitem.read', access: 'read' }],
  steps: [{ key: 'connection', title: 'Project' }],
};

const detail = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Demo source',
  providerKey: 'sample-work-items',
  providerName: 'Sample work items (demo)',
  category: 'work-item',
  status: 'connected',
  enabled: false,
  accessMode: 'read_only',
  lastSuccessAt: '2026-11-18T08:00:00.000Z',
  updatedAt: '2026-11-18T08:00:00.000Z',
  configVersion: 1,
  config: { projectName: 'Retail Web' },
  hasCredentials: true,
  capabilities: [
    { capability: 'workitem.read', access: 'read', support: 'supported', granted: true },
    { capability: 'workitem.search', access: 'read', support: 'partial', reason: 'Matches titles only', granted: true },
    { capability: 'workitem.project.list', access: 'read', support: 'unsupported', reason: 'No endpoint', granted: false },
  ],
  latestTest: { id: 't1', status: 'succeeded', requestedAt: '2026-11-18T08:00:00.000Z', finishedAt: '2026-11-18T08:00:02.000Z', result: { ok: true, message: 'Connected to the demo source.' } },
  hostIssues: [],
  canEnable: true,
  permissionReport: { granted: ['read'], writePermissionsDetected: [] },
  ...over,
});

const ID = '11111111-1111-4111-8111-111111111111';

describe('connector list', () => {
  it('shows status and use in plain language, and offers Add connector only to managers', async () => {
    const items = [{ ...detail(), config: undefined }];
    const admin = renderApp('/connectors', { me: { status: 200, body: meFor('administrator') }, routes: { '/api/v1/connectors': { status: 200, body: { items } } } });
    const row = (await screen.findByRole('link', { name: 'Demo source' })).closest('tr')!;
    expect(within(row).getByText('Connected')).toBeTruthy();
    expect(within(row).getByText('Switched off')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add connector' })).toBeTruthy();
    admin.unmount();
    renderApp('/connectors', { me: { status: 200, body: meFor('qa_lead') }, routes: { '/api/v1/connectors': { status: 200, body: { items } } } });
    await screen.findByRole('link', { name: 'Demo source' });
    expect(screen.queryByRole('link', { name: 'Add connector' })).toBeNull();
  });

  it('keeps the wizard behind the manage permission', async () => {
    const view = renderApp('/connectors/new', { me: { status: 200, body: meFor('qa_lead') } });
    expect(await screen.findByRole('heading', { name: 'You do not have access to this page' })).toBeTruthy();
    expect(view.calls.some((c) => c.url.includes('connector-providers'))).toBe(false);
  });
});

describe('connector detail', () => {
  const backend = (role: 'administrator' | 'qa_lead', over: Record<string, unknown> = {}) => ({
    me: { status: 200, body: meFor(role) },
    routes: {
      [`/api/v1/connectors/${ID}`]: { status: 200, body: detail(role === 'qa_lead' ? { config: undefined, ...over } : over) },
      '/api/v1/connector-providers': { status: 200, body: { items: [provider] } },
      [`/api/v1/connectors/${ID}/operations?limit=25`]: {
        status: 200,
        body: { items: [{ seq: 2, at: '2026-11-18T09:00:00.000Z', actorType: 'step', actorId: 'read_items', capability: 'workitem.read', outcome: 'denied', denialReason: 'connector instance is disabled', durationMs: 3 }, { seq: 1, at: '2026-11-18T08:59:00.000Z', actorType: 'step', actorId: 'read_items', capability: 'workitem.read', outcome: 'ok', durationMs: 12 }] },
      },
    },
  });

  it('shows the six read-only checks when the connector is a source repository', async () => {
    const layers = [
      { id: 'access-mode', label: 'The connection is read-only', state: 'holds', detail: 'Stored read-only.' },
      { id: 'credential', label: 'The token has no write permission', state: 'blocked', detail: 'Replace the token.' },
    ];
    renderApp(`/connectors/${ID}`, backend('administrator', { category: 'source-repo', readOnlyLayers: layers }));
    expect(await screen.findByText(/Holds: The connection is read-only/)).toBeTruthy();
    expect(screen.getByText(/Blocked: The token has no write permission/)).toBeTruthy();
  });

  it('shows the per-capability table with support, usability and reasons', async () => {
    renderApp(`/connectors/${ID}`, backend('administrator'));
    const table = await screen.findByRole('table', { name: 'What this connector can do' });
    const search = within(table).getByText('workitem.search').closest('tr')!;
    expect(within(search).getByText('Partly supported')).toBeTruthy();
    expect(within(search).getByText('Matches titles only')).toBeTruthy();
    const list = within(table).getByText('workitem.project.list').closest('tr')!;
    expect(within(list).getByText('Not supported')).toBeTruthy();
    expect(screen.getByText(/Test passed: Connected to the demo source/)).toBeTruthy();
  });

  it('lets an administrator switch on, and tells a QA lead they can look but not change', async () => {
    const view = renderApp(`/connectors/${ID}`, { ...backend('administrator'), routes: { ...backend('administrator').routes, [`POST /api/v1/connectors/${ID}/enable`]: { status: 200, body: detail({ enabled: true }) } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Switch on' }));
    await waitFor(() => expect(view.calls.some((c) => c.method === 'POST' && c.url.endsWith('/enable'))).toBe(true));
    view.unmount();
    renderApp(`/connectors/${ID}`, backend('qa_lead'));
    await screen.findByText(/Test passed/);
    expect(screen.queryByRole('button', { name: 'Switch on' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByText('Credentials')).toBeNull();
  });

  it('shows the operation log with refusals in plain words to auditors', async () => {
    renderApp(`/connectors/${ID}`, backend('administrator'));
    const log = await screen.findByRole('table', { name: 'Recent connector calls' });
    expect(within(log).getByText('Refused: connector instance is disabled')).toBeTruthy();
    expect(within(log).getByText('Succeeded')).toBeTruthy();
  });

  it('never shows a stored credential, only that one exists', async () => {
    renderApp(`/connectors/${ID}`, backend('administrator'));
    expect(await screen.findByText('Credentials are stored. Their values are never shown.')).toBeTruthy();
    const input = screen.getByLabelText('Demo key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
  });

  it('offers to approve an unapproved host to administrators', async () => {
    const issue = { host: 'squash.corp.local', reason: 'not-approved', suggestion: { hostPattern: 'squash.corp.local', internal: true, allowHttp: true } };
    const b = backend('administrator', { hostIssues: [issue], status: 'error', canEnable: false });
    const view = renderApp(`/connectors/${ID}`, { ...b, routes: { ...b.routes, 'POST /api/v1/egress/hosts': { status: 201, body: {} } } });
    expect(await screen.findByText(/is not on the approved-host list/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Approve squash.corp.local/ }));
    await waitFor(() => expect(view.calls.some((c) => c.method === 'POST' && c.url === '/api/v1/egress/hosts')).toBe(true));
  });
});

describe('add connector wizard', () => {
  it('is driven by the provider descriptor: choose, details, save, then test', async () => {
    const view = renderApp('/connectors/new', {
      me: { status: 200, body: meFor('administrator') },
      routes: {
        '/api/v1/connector-providers': { status: 200, body: { items: [provider] } },
        'POST /api/v1/connectors': { status: 201, body: detail({ status: 'draft', canEnable: false, latestTest: undefined, capabilities: [] }) },
        [`/api/v1/connectors/${ID}`]: { status: 200, body: detail({ status: 'draft', canEnable: false, latestTest: undefined, capabilities: [] }) },
        '/api/v1/connectors': { status: 200, body: { items: [] } },
      },
    });
    await userEvent.click(await screen.findByRole('radio', { name: /Sample work items/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Demo source');
    await userEvent.type(screen.getByLabelText('Demo project name'), 'Retail Web');
    await userEvent.type(screen.getByLabelText('Demo key'), 'demo-secret-value');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('button', { name: 'Test connection' })).toBeTruthy();
    const post = view.calls.find((c) => c.method === 'POST' && c.url === '/api/v1/connectors');
    expect(post).toBeTruthy();
    expect(screen.queryByDisplayValue('demo-secret-value')).toBeNull();
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('approved hosts page', () => {
  it('lists hosts for administrators and keeps others out', async () => {
    const a = renderApp('/admin/hosts', {
      me: { status: 200, body: meFor('administrator') },
      routes: { '/api/v1/egress/hosts': { status: 200, body: { items: [{ id: 'h1', hostPattern: 'squash.corp.local', internal: true, allowHttp: true, approvedAt: '2026-11-18T08:00:00.000Z' }] } } },
    });
    const table = await screen.findByRole('table', { name: 'Approved hosts' });
    expect(within(table).getByText('squash.corp.local')).toBeTruthy();
    expect(within(table).getByText('Allowed')).toBeTruthy();
    a.unmount();
    renderApp('/admin/hosts', { me: { status: 200, body: meFor('qa_lead') } });
    expect(await screen.findByRole('heading', { name: 'You do not have access to this page' })).toBeTruthy();
  });
});
