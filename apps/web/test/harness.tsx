import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createApiClient } from '../src/api/client';
import { ApiProvider } from '../src/api/context';
import type { Navigator } from '../src/auth/session';
import { buildRouter } from '../src/router';
import { ROLE_PERMISSIONS, type Role } from '../../../packages/domain/src/roles';

window.scrollTo = () => undefined;

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface Backend {
  me?: { status: number; body?: unknown };
  routes?: Record<string, { status: number; body: unknown }>;
}

export function meFor(role: Role, name = 'Dasun') {
  return { userId: 'u-1', displayName: name, roles: [role], permissions: [...ROLE_PERMISSIONS[role]] };
}

export function fakeBackend(b: Backend) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, headers: (init?.headers ?? {}) as Record<string, string> });
    const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/v1/me') return reply(b.me?.status ?? 200, b.me?.body);
    const r = b.routes?.[url];
    return r ? reply(r.status, r.body) : reply(404, { error: { class: 'not-found', message: 'no route' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export function renderApp(path: string, backend: Backend) {
  const { calls, fetchImpl } = fakeBackend(backend);
  const assigned: string[] = [];
  const navigator: Navigator = { assign: (u) => void assigned.push(u), currentPath: () => path };
  const client = createApiClient({ fetchImpl });
  const router = buildRouter({ history: createMemoryHistory({ initialEntries: [path] }), navigator });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <ApiProvider client={client}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiProvider>,
  );
  return { ...utils, calls, assigned };
}
