// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient, ApiError } from '../src/api/client';
import { MePermissionsResponse } from '@qa/contracts';
import { fakeBackend, meFor, renderApp } from './harness';

afterEach(cleanup);

const nav = () => within(screen.getByRole('navigation', { name: 'Primary' }));
const labels = () => nav().getAllByRole('link').map((a) => a.textContent);

const ALL_MAIN = ['Dashboard', 'Workflows', 'Executions', 'Test Cases', 'Automation Mapping', 'Evidence', 'Reports & Analytics'];

describe('role-based navigation (ui-design.md section 1)', () => {
  it('Administrator sees every item', async () => {
    renderApp('/', { me: { status: 200, body: meFor('administrator') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual([
      ...ALL_MAIN, 'Connectors', 'Environments', 'AI Agents', 'AI Models', 'Users & Identity mapping', 'Approved hosts', 'Security & Approvals', 'Audit Log', 'System Settings',
    ]);
  });

  it('QA Lead: no identity/settings administration, only the audit log', async () => {
    renderApp('/', { me: { status: 200, body: meFor('qa_lead') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual([...ALL_MAIN, 'Connectors', 'Environments', 'AI Agents', 'AI Models', 'Audit Log']);
  });

  it('QA Engineer: no agents, models or administration', async () => {
    renderApp('/', { me: { status: 200, body: meFor('qa_engineer') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual([...ALL_MAIN, 'Connectors', 'Environments']);
  });

  it('Business User: no mapping, connectors, environments or configuration', async () => {
    renderApp('/', { me: { status: 200, body: meFor('business_user') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual(['Dashboard', 'Workflows', 'Executions', 'Test Cases', 'Evidence', 'Reports & Analytics']);
  });

  it('shows the signed-in name and role names in plain language', async () => {
    renderApp('/', { me: { status: 200, body: meFor('qa_lead', 'Dasun PT') } });
    expect(await screen.findByText('Dasun PT')).toBeTruthy();
    expect(screen.getByText('QA Lead')).toBeTruthy();
  });
});

describe('route guard', () => {
  it('explains instead of rendering a blank page when a direct URL is outside the role, and never calls the API for it', async () => {
    const view = renderApp('/admin/identity', { me: { status: 200, body: meFor('qa_engineer') } });
    expect(await screen.findByRole('heading', { name: 'You do not have access to this page' })).toBeTruthy();
    expect(view.calls.some((c) => c.url.includes('/identity/mappings'))).toBe(false);
  });

  it('shows a helpful page for unknown addresses', async () => {
    renderApp('/nope', { me: { status: 200, body: meFor('administrator') } });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('placeholder pages say which phase delivers them', async () => {
    renderApp('/workflows', { me: { status: 200, body: meFor('qa_lead') } });
    expect(await screen.findByText(/Phase 4/)).toBeTruthy();
  });
});

describe('data pages', () => {
  it('Identity mapping renders the group to role table for an Administrator', async () => {
    renderApp('/admin/identity', {
      me: { status: 200, body: meFor('administrator') },
      routes: { '/api/v1/identity/mappings': { status: 200, body: { items: [{ idpGroup: 'QA-Platform-Leads', role: 'qa_lead', enabled: true }, { idpGroup: 'QA-Platform-Users', role: 'business_user', enabled: false }] } } },
    });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('QA-Platform-Leads')).toBeTruthy();
    expect(within(table).getByText('QA Lead')).toBeTruthy();
    expect(within(table).getByText('Disabled')).toBeTruthy();
  });

  it('Connectors shows an empty state with the next step, and an error with retry', async () => {
    const ok = renderApp('/connectors', { me: { status: 200, body: meFor('qa_lead') }, routes: { '/api/v1/connectors': { status: 200, body: { items: [] } } } });
    expect(await screen.findByText('No connectors have been configured yet.')).toBeTruthy();
    ok.unmount();
    renderApp('/connectors', { me: { status: 200, body: meFor('qa_lead') }, routes: { '/api/v1/connectors': { status: 500, body: { error: { class: 'internal', message: 'Internal error' } } } } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('AI Models page', () => {
  it('shows provider health and what each model supports, in plain language', async () => {
    renderApp('/models', {
      me: { status: 200, body: meFor('qa_lead') },
      routes: {
        '/api/v1/llm/providers': {
          status: 200,
          body: { items: [{ id: 'ollama', kind: 'local', adapter: 'ollama', enabled: true, health: { ok: true, latencyMs: 42 }, models: [{ name: 'qwen2.5:7b', contextTokens: 32768, supportsToolCalling: true, supportsStructuredOutput: true, supportsVision: false }] }] },
        },
      },
    });
    expect(await screen.findByText('Reachable (42 ms)')).toBeTruthy();
    expect(screen.getByText(/runs in your network/)).toBeTruthy();
    const row = within(screen.getByRole('table')).getByText('qwen2.5:7b').closest('tr')!;
    expect(within(row).getByText('32,768 tokens')).toBeTruthy();
    expect(within(row).getAllByText('Yes')).toHaveLength(2);
    expect(within(row).getByText('No')).toBeTruthy();
  });

  it('explains an unreachable provider and an empty configuration', async () => {
    const down = renderApp('/models', {
      me: { status: 200, body: meFor('administrator') },
      routes: { '/api/v1/llm/providers': { status: 200, body: { items: [{ id: 'ollama', kind: 'local', adapter: 'ollama', enabled: true, health: { ok: false, latencyMs: 4000, detail: 'unreachable' }, models: [] }] } } },
    });
    expect(await screen.findByText('Unreachable: unreachable')).toBeTruthy();
    expect(screen.getByText(/cannot be listed while the provider is unreachable/)).toBeTruthy();
    down.unmount();
    renderApp('/models', { me: { status: 200, body: meFor('administrator') }, routes: { '/api/v1/llm/providers': { status: 200, body: { items: [] } } } });
    expect(await screen.findByText('No model provider is configured yet.')).toBeTruthy();
  });

  it('is hidden from QA Engineers and explains why on a direct visit', async () => {
    renderApp('/models', { me: { status: 200, body: meFor('qa_engineer') } });
    expect(await screen.findByRole('heading', { name: 'You do not have access to this page' })).toBeTruthy();
  });
});

describe('authentication', () => {
  it('sends an unauthenticated visitor to the API login with a return path', async () => {
    const view = renderApp('/executions?tab=history', { me: { status: 401, body: { error: { class: 'auth', message: 'Authentication required' } } } });
    await waitFor(() => expect(view.assigned).toEqual(['/api/v1/auth/login?returnTo=%2Fexecutions%3Ftab%3Dhistory']));
    expect(screen.getByText('Redirecting to sign-in')).toBeTruthy();
  });

  it('shows an unreachable-platform message with retry instead of a blank screen', async () => {
    renderApp('/', { me: { status: 500, body: { error: { class: 'internal', message: 'x' } } } });
    expect(await screen.findByText('The platform is unreachable', undefined, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('sign out sends the CSRF token and then follows the identity provider logout URL', async () => {
    const view = renderApp('/', {
      me: { status: 200, body: meFor('qa_lead') },
      routes: {
        '/api/v1/auth/session': { status: 200, body: { csrfToken: 'csrf-123', expiresAt: '2026-11-18T00:00:00Z' } },
        '/api/v1/auth/logout': { status: 200, body: { loggedOut: true, logoutUrl: 'https://idp.example/logout?x=1' } },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(view.assigned).toEqual(['https://idp.example/logout?x=1']));
    const post = view.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/api/v1/auth/logout');
    expect(post.headers['x-csrf-token']).toBe('csrf-123');
  });

  it('shows a readable page for each sign-in failure code and offers a retry', async () => {
    const cases: [string, RegExp][] = [
      ['denied', /no access to the platform/],
      ['unavailable', /sign-in service is unavailable/],
      ['failed', /Sign-in did not complete/],
    ];
    for (const [code, text] of cases) {
      const v = renderApp(`/signin-error?code=${code}`, {});
      expect(await screen.findByRole('heading', { name: text })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Sign in again' }).getAttribute('href')).toBe('/api/v1/auth/login');
      v.unmount();
    }
  });
});

describe('api client', () => {
  it('fetches the CSRF token once for state-changing calls, omits it on GET, and works without the endpoint (dev)', async () => {
    const { calls, fetchImpl } = fakeBackend({ me: { status: 200, body: meFor('qa_lead') }, routes: { '/api/v1/auth/session': { status: 200, body: { csrfToken: 't1', expiresAt: 'x' } }, '/api/v1/x': { status: 200, body: {} } } });
    const c = createApiClient({ fetchImpl });
    const any = { parse: (v: unknown) => v } as never;
    await c.get('/api/v1/x', any);
    await c.post('/api/v1/x', {}, any);
    await c.post('/api/v1/x', {}, any);
    expect(calls.filter((x) => x.url === '/api/v1/auth/session')).toHaveLength(1);
    expect(calls.filter((x) => x.method === 'POST').every((x) => x.headers['x-csrf-token'] === 't1')).toBe(true);
    expect(calls.find((x) => x.method === 'GET' && x.url === '/api/v1/x')!.headers['x-csrf-token']).toBeUndefined();

    const dev = fakeBackend({ routes: { '/api/v1/x': { status: 200, body: {} } } });
    await createApiClient({ fetchImpl: dev.fetchImpl }).post('/api/v1/x', {}, any);
    expect(dev.calls.find((x) => x.method === 'POST')!.headers['x-csrf-token']).toBeUndefined();
  });

  it('maps error responses to ApiError and validates success payloads', async () => {
    const { fetchImpl } = fakeBackend({ me: { status: 200, body: { userId: 'u' } }, routes: { '/api/v1/connectors': { status: 403, body: { error: { class: 'denied', message: 'Forbidden' } } } } });
    const c = createApiClient({ fetchImpl });
    await expect(c.get('/api/v1/connectors', MePermissionsResponse)).rejects.toMatchObject({ status: 403, errorClass: 'denied' });
    await expect(c.get('/api/v1/me', MePermissionsResponse)).rejects.toThrow();
    expect(new ApiError(1, 'x', 'm')).toBeInstanceOf(Error);
  });
});
