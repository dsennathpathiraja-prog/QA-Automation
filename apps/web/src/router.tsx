import { Link, Outlet, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SessionGate, useSession, type Navigator } from './auth/session';
import { AppShell } from './layout/AppShell';
import { NAV_ITEMS, type NavItem } from './nav';
import { AccessDenied, ComingSoon, PageHeader } from './pages/common';
import { Connectors } from './pages/Connectors';
import { Dashboard } from './pages/Dashboard';
import { IdentityMapping } from './pages/IdentityMapping';
import { SignInError } from './pages/SignInError';

function Guarded({ item, children }: { item: NavItem; children?: ReactNode }) {
  const s = useSession();
  if (!s.canAny(item.anyOf)) return <AccessDenied title={item.label} />;
  return <>{children ?? <ComingSoon title={item.label} summary={item.summary} phase={item.phase} />}</>;
}

const NotFound = () => (
  <>
    <PageHeader title="Page not found" description="That address does not exist." />
    <Link to="/" className="text-blue-700 underline dark:text-blue-300">
      Back to the dashboard
    </Link>
  </>
);

const real: Record<string, () => ReactNode> = { dashboard: () => <Dashboard />, connectors: () => <Connectors />, identity: () => <IdentityMapping /> };

export interface RouterOptions {
  history?: Parameters<typeof createRouter>[0]['history'];
  navigator?: Navigator;
}

export function buildRouter(opts: RouterOptions = {}): AnyRouter {
  const root = createRootRoute({ component: Outlet, notFoundComponent: NotFound });

  const signInError = createRoute({
    getParentRoute: () => root,
    path: '/signin-error',
    validateSearch: (s: Record<string, unknown>) => ({ code: typeof s.code === 'string' ? s.code : undefined }),
    component: function SignInErrorRoute() {
      return <SignInError code={signInError.useSearch().code} />;
    },
  });

  const shell = createRoute({
    getParentRoute: () => root,
    id: 'shell',
    component: () => (
      <SessionGate navigator={opts.navigator}>
        <AppShell />
      </SessionGate>
    ),
    notFoundComponent: NotFound,
  });

  const pages = NAV_ITEMS.map((item) =>
    createRoute({
      getParentRoute: () => shell,
      path: item.to,
      component: () => <Guarded item={item}>{real[item.id]?.()}</Guarded>,
    }),
  );

  return createRouter({ routeTree: root.addChildren([signInError, shell.addChildren(pages)]), history: opts.history, defaultPreload: false });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
