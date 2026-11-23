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

const ALL_MAIN = ['Dashboard', 'Workflows', 'Executions', 'Test Cases', 'Evidence', 'Reports & Analytics'];

describe('role-based navigation (ui-design.md section 1)', () => {
  it('Administrator sees every item', async () => {
    renderApp('/', { me: { status: 200, body: meFor('administrator') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual([
      ...ALL_MAIN, 'Projects', 'Connectors', 'Environments', 'Users & Identity mapping', 'Approved hosts', 'Security & Approvals', 'Audit Log', 'System Settings',
    ]);
  });

  it('QA Lead: no identity/settings administration, only the audit log', async () => {
    renderApp('/', { me: { status: 200, body: meFor('qa_lead') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual([...ALL_MAIN, 'Projects', 'Connectors', 'Environments', 'Audit Log']);
  });

  it('QA Engineer: no administration', async () => {
    renderApp('/', { me: { status: 200, body: meFor('qa_engineer') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual([...ALL_MAIN, 'Projects', 'Connectors', 'Environments']);
  });

  it('Business User: projects only in configuration (no connectors or environments)', async () => {
    renderApp('/', { me: { status: 200, body: meFor('business_user') } });
    await screen.findByRole('navigation', { name: 'Primary' });
    expect(labels()).toEqual(['Dashboard', 'Workflows', 'Executions', 'Test Cases', 'Evidence', 'Reports & Analytics', 'Projects']);
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

  it('Evidence Open evidence navigates to the dedicated run detail page', async () => {
    const user = userEvent.setup();
    const runId = '44444444-4444-4444-8444-444444444444';
    const caseId = '55555555-5555-4555-8555-555555555555';
    renderApp('/evidence', {
      me: { status: 200, body: meFor('qa_lead') },
      routes: {
        '/api/v1/work-item-executions': {
          status: 200,
          body: {
            workItems: [],
            environments: [],
            items: [{
              id: runId,
              workItem: 'rg:1436518e-0000-4000-8000-000000000001',
              environmentId: '33333333-3333-4333-8333-333333333333',
              environmentName: 'QA',
              caseCount: 1,
              status: 'completed',
              createdAt: '2026-11-22T10:00:00.000Z',
              finishedAt: '2026-11-22T10:05:00.000Z',
              counts: { total: 1, queued: 0, running: 0, passed: 1, failed: 0, blocked: 0, skipped: 0, completed: 1 },
              results: [{
                id: 'r1',
                testCaseId: caseId,
                name: 'Login smoke',
                status: 'Passed',
                message: 'ok',
                hasScreenshot: true,
              }],
            }],
          },
        },
        [`/api/v1/work-item-executions/${runId}`]: {
          status: 200,
          body: {
            id: runId,
            workItem: 'rg:1436518e-0000-4000-8000-000000000001',
            environmentId: '33333333-3333-4333-8333-333333333333',
            environmentName: 'QA',
            caseCount: 1,
            status: 'completed',
            createdAt: '2026-11-22T10:00:00.000Z',
            finishedAt: '2026-11-22T10:05:00.000Z',
            counts: { total: 1, queued: 0, running: 0, passed: 1, failed: 0, blocked: 0, skipped: 0, completed: 1 },
            results: [{
              id: 'r1',
              testCaseId: caseId,
              name: 'Login smoke',
              status: 'Passed',
              message: 'ok',
              hasScreenshot: true,
            }],
          },
        },
        [`/api/v1/work-item-executions/${runId}/cases/${caseId}/screenshot`]: {
          status: 200,
          body: {
            testCaseId: caseId,
            name: 'Login smoke',
            contentType: 'image/png',
            pngBase64: 'a'.repeat(220),
          },
        },
        '/api/v1/executions/1436518e-0000-4000-8000-000000000001/events': {
          status: 200,
          body: { items: [] },
        },
      },
    });
    expect(await screen.findByText(/Browse screenshots/i)).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Runs with evidence' })).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: 'Open evidence' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Run detail' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Back to Evidence/i })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Evidence' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Run evidence' })).toBeTruthy();
    expect(await screen.findByAltText(/Screenshot evidence for Login smoke/)).toBeTruthy();
  });

  it('Reports Open report navigates to the dedicated run detail page with charts', async () => {
    const user = userEvent.setup();
    const runId = '77777777-7777-4777-8777-777777777777';
    renderApp('/reports', {
      me: { status: 200, body: meFor('qa_lead') },
      routes: {
        '/api/v1/work-item-executions': {
          status: 200,
          body: {
            workItems: [],
            environments: [],
            items: [{
              id: runId,
              workItem: '2309',
              environmentId: '33333333-3333-4333-8333-333333333333',
              environmentName: 'PayNSure',
              caseCount: 130,
              status: 'completed',
              createdAt: '2026-11-22T12:00:00.000Z',
              finishedAt: '2026-11-22T12:10:00.000Z',
              counts: { total: 130, queued: 0, running: 0, passed: 130, failed: 0, blocked: 0, skipped: 0, completed: 130 },
            }],
          },
        },
        [`/api/v1/work-item-executions/${runId}`]: {
          status: 200,
          body: {
            id: runId,
            workItem: '2309',
            environmentId: '33333333-3333-4333-8333-333333333333',
            environmentName: 'PayNSure',
            caseCount: 130,
            status: 'completed',
            createdAt: '2026-11-22T12:00:00.000Z',
            finishedAt: '2026-11-22T12:10:00.000Z',
            counts: { total: 130, queued: 0, running: 0, passed: 130, failed: 0, blocked: 0, skipped: 0, completed: 130 },
            results: Array.from({ length: 130 }, (_, i) => ({
              id: `r${i}`,
              testCaseId: `c${i}`,
              name: `Case ${i}`,
              status: 'Passed',
              message: 'ok',
              hasScreenshot: false,
            })),
          },
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Open report' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Run detail' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Back to Reports/i })).toBeTruthy();
    const report = await screen.findByRole('region', { name: 'Run report' });
    expect(within(report).getByText('130 passed')).toBeTruthy();
    expect(within(report).getByRole('img', { name: /Stacked bar/i })).toBeTruthy();
    expect(within(report).getByRole('img', { name: /Donut chart of 130 cases/i })).toBeTruthy();
  });

  it('Run detail page shows tallies and regression-report.md', async () => {
    const runId = '66666666-6666-4666-8666-666666666666';
    const workflowRunId = '1436518e-0000-4000-8000-000000000099';
    const eventsPath = `/api/v1/executions/${workflowRunId}/events`;
    const { calls } = renderApp(`/runs/${runId}?view=report&from=reports`, {
      me: { status: 200, body: meFor('qa_engineer') },
      routes: {
        [`/api/v1/work-item-executions/${runId}`]: {
          status: 200,
          body: {
            id: runId,
            workItem: `rg:${workflowRunId}`,
            environmentId: '33333333-3333-4333-8333-333333333333',
            environmentName: 'QA',
            caseCount: 2,
            status: 'completed',
            createdAt: '2026-11-22T11:00:00.000Z',
            finishedAt: '2026-11-22T11:05:00.000Z',
            squashSync: 'Squash recorded 1 execution status.',
            counts: { total: 2, queued: 0, running: 0, passed: 1, failed: 0, blocked: 0, skipped: 1, completed: 2 },
            results: [
              { id: 'r1', testCaseId: 'c1', name: 'Login', status: 'Passed', message: 'ok', hasScreenshot: true },
              { id: 'r2', testCaseId: 'c2', name: 'Draft', status: 'Skipped', message: 'Not Automated: draft', hasScreenshot: false },
            ],
          },
        },
        [eventsPath]: {
          status: 200,
          body: {
            items: [{
              seq: 9,
              kind: 'step.completed',
              at: '2026-11-22T11:05:00.000Z',
              payload: {
                stepId: 'report',
                stepType: 'rg.regression-report',
                summary: 'Wrote regression report.',
                outputs: {
                  artifactMarkdown: '# Regression report: demo\n\n## Summary\n\n- **Passed:** 1\n- **Not Automated:** 1\n',
                  artifactPath: 'reports/regression/demo.regression-report.md',
                  tallies: { passed: 1, failed: 0, blocked: 0, skipped: 0, notAutomated: 1 },
                  syncSummary: 'Squash recorded 1 execution status.',
                },
              },
            }],
          },
        },
      },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Run detail' })).toBeTruthy();
    const report = await screen.findByRole('region', { name: 'Run report' });
    expect(within(report).getByText('1 passed')).toBeTruthy();
    expect(within(report).getByText('1 not automated')).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((c) => c.url === eventsPath)).toBe(true);
    });
    expect(await screen.findByText('reports/regression/demo.regression-report.md')).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toMatch(/Passed:\*\* 1/);
  });

  it('lists test case collections kept in this platform', async () => {
    renderApp('/test-cases', {
      me: { status: 200, body: meFor('business_user') },
      routes: {
        '/api/v1/test-collections': {
          status: 200,
          body: { items: [{ id: '33333333-3333-4333-8333-333333333333', name: 'QA-1', description: 'Cases generated for QA-1', size: 1 }] },
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'QA-1' })).toBeTruthy();
    expect(screen.getByText(/1 case/)).toBeTruthy();
    expect(screen.getByText(/Open a collection to see positive, negative, and edge cases/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear platform test cases' })).toBeNull();
  });

  it('lists work-item runs on Executions and workflow history on the History tab', async () => {
    const user = userEvent.setup();
    renderApp('/executions', {
      me: { status: 200, body: meFor('qa_engineer') },
      routes: {
        '/api/v1/work-item-executions': {
          status: 200,
          body: {
            workItems: [{ workItem: 'QA-1', caseCount: 2 }],
            environments: [{ id: '33333333-3333-4333-8333-333333333333', name: 'QA', kind: 'qa' }],
            items: [{ id: '44444444-4444-4444-8444-444444444444', workItem: 'QA-1', environmentId: '33333333-3333-4333-8333-333333333333', environmentName: 'QA', caseCount: 2, status: 'prepared', createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }],
          },
        },
        '/api/v1/executions': { status: 200, body: { items: [{ id: '1436518e-0000-4000-8000-000000000001', workflowId: '11111111-1111-4111-8111-111111111111', workflowName: 'Checkout', status: 'succeeded', stepIndex: 10, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:05:00.000Z' }] } },
        '/api/v1/executions/1436518e-0000-4000-8000-000000000001/events': {
          status: 200,
          body: {
            items: [{
              seq: 1,
              kind: 'step.completed',
              at: '2026-11-18T10:00:00.000Z',
              payload: {
                stepId: 'read_story',
                summary: 'Read work item QA-1 — Guest checkout.',
                outputs: {
                  artifactMarkdown: '# Work item QA-1 — Guest checkout\n\n## Context\n\n- **Title:** Guest checkout\n',
                  artifactPath: 'explore/checkout/qa-1.story.md',
                },
              },
            }],
          },
        },
      },
    });
    expect(await screen.findByRole('tab', { name: 'Execution' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Regression' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Workflows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reports' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Prepare execution' })).toBeTruthy();
    expect(screen.getByText(/soft-deleted cases are excluded/i)).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Setup ready to run' })).toBeTruthy();
    expect(screen.getByText(/recent preparation/i)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /Prepared test execution/ }));
    expect(await screen.findByRole('button', { name: 'Run' })).toBeTruthy();
    expect(screen.getByText(/Only recently added preparations/i)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText(/Regression runs resolve approved automation/i)).toBeTruthy();
    expect(screen.getByText(/After a run finishes, open/i)).toBeTruthy();
    expect(screen.getByText('Succeeded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open workflow' })).toBeTruthy();
    const checkout = await screen.findByRole('button', { name: /Checkout/ });
    await user.click(checkout);
    expect((await screen.findByRole('region', { name: 'Selected run' })).textContent).toMatch(/Read work item QA-1/);
    expect(screen.getByText(/Markdown artifact/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByText(/explore\/checkout\/qa-1\.story\.md/)).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toMatch(/Title:\*\* Guest checkout/);
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
    const ok = renderApp('/connectors', { me: { status: 200, body: meFor('qa_lead') }, routes: { '/api/v1/connectors?projectId=01900000-0000-7000-8000-000000000001': { status: 200, body: { items: [] } } } });
    expect(await screen.findByText('No connectors have been configured for this project yet.')).toBeTruthy();
    ok.unmount();
    renderApp('/connectors', { me: { status: 200, body: meFor('qa_lead') }, routes: { '/api/v1/connectors?projectId=01900000-0000-7000-8000-000000000001': { status: 500, body: { error: { class: 'internal', message: 'Internal error' } } } } });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
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
