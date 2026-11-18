// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { meFor, renderApp } from './harness';

afterEach(cleanup);

const ID = '11111111-1111-4111-8111-111111111111';
const env = {
  id: ID,
  name: 'QA',
  kind: 'qa',
  applicationUrl: 'https://qa.shop.example/',
  enabled: true,
  selectable: true,
  browser: { browser: 'chromium', headless: true },
  restrictions: { maxParallelism: 1, prodSafeOnly: false },
  createdAt: '2026-11-18T08:00:00.000Z',
  updatedAt: '2026-11-18T08:00:00.000Z',
};

describe('environments', () => {
  it('lists environments and offers creation only to an administrator', async () => {
    const admin = renderApp('/environments', { me: { status: 200, body: meFor('administrator') }, routes: { '/api/v1/environments': { status: 200, body: { items: [env] } } } });
    expect(await screen.findByRole('link', { name: 'QA' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create environment' })).toBeTruthy();
    admin.unmount();
    renderApp('/environments', { me: { status: 200, body: meFor('qa_engineer') }, routes: { '/api/v1/environments': { status: 200, body: { items: [env] } } } });
    await screen.findByRole('link', { name: 'QA' });
    expect(screen.queryByRole('button', { name: 'Create environment' })).toBeNull();
  });

  it('shows a saved authentication secret as a marker and an empty password field', async () => {
    const user = userEvent.setup();
    renderApp(`/environments/${ID}`, {
      me: { status: 200, body: meFor('administrator') },
      routes: {
        [`/api/v1/environments/${ID}`]: { status: 200, body: env },
        [`/api/v1/environments/${ID}/auth-profiles`]: { status: 200, body: { items: [{ id: 'p1', name: 'qa-user', type: 'form-login', config: { username: 'qa.bot' }, hasSecret: true }] } },
      },
    });
    await user.click(await screen.findByRole('tab', { name: 'Authentication' }));
    expect(await screen.findByText(/qa-user/)).toBeTruthy();
    expect(screen.getByText(/•••••••• saved/)).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByDisplayValue('pw-not-shown')).toBeNull();
  });
});
