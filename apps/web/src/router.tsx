import { Link, Outlet, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SessionGate, useSession, type Navigator } from './auth/session';
import { AppShell } from './layout/AppShell';
import { NAV_ITEMS, type NavItem } from './nav';
import { AccessDenied, ComingSoon, PageHeader } from './pages/common';
import { AiModels } from './pages/AiModels';
import { ApprovedHosts } from './pages/ApprovedHosts';
import { Connectors } from './pages/Connectors';
import { ConnectorDetailPage } from './pages/connectors/ConnectorDetailPage';
import { ConnectorWizard } from './pages/connectors/ConnectorWizard';
import { Dashboard } from './pages/Dashboard';
import { Executions } from './pages/Executions';
import { EnvironmentPage } from './pages/environments/EnvironmentPage';
import { Environments } from './pages/Environments';
import { TestCasePage, TestCases, TestCollectionPage } from './pages/TestCases';
import { Workflows } from './pages/Workflows';
import { WorkflowPage } from './pages/workflows/WorkflowPage';
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

const real: Record<string, () => ReactNode> = { dashboard: () => <Dashboard />, workflows: () => <Workflows />, executions: () => <Executions />, 'test-cases': () => <TestCases />, connectors: () => <Connectors />, environments: () => <Environments />, identity: () => <IdentityMapping />, hosts: () => <ApprovedHosts />, models: () => <AiModels /> };

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

  const pages = NAV_ITEMS.filter((item) => item.id !== 'executions').map((item) =>
    createRoute({
      getParentRoute: () => shell,
      path: item.to,
      component: () => <Guarded item={item}>{real[item.id]?.()}</Guarded>,
    }),
  );
  const executionsItem = NAV_ITEMS.find((item) => item.id === 'executions')!;
  const executions = createRoute({
    getParentRoute: () => shell,
    path: '/executions',
    validateSearch: (s: Record<string, unknown>) => ({ tab: s.tab === 'history' ? ('history' as const) : undefined }),
    component: () => <Guarded item={executionsItem}><Executions /></Guarded>,
  });

  const connectorItem = NAV_ITEMS.find((i) => i.id === 'connectors')!;
  const manageItem: NavItem = { ...connectorItem, anyOf: ['connector.manage'] };
  const connectorNew = createRoute({ getParentRoute: () => shell, path: '/connectors/new', component: () => <Guarded item={manageItem}><ConnectorWizard /></Guarded> });
  const connectorDetail = createRoute({ getParentRoute: () => shell, path: '/connectors/$id', component: () => <Guarded item={connectorItem}><ConnectorDetailPage /></Guarded> });
  const environmentItem = NAV_ITEMS.find((i) => i.id === 'environments')!;
  const environmentDetail = createRoute({ getParentRoute: () => shell, path: '/environments/$id', component: () => <Guarded item={environmentItem}><EnvironmentPage /></Guarded> });
  const workflowItem = NAV_ITEMS.find((i) => i.id === 'workflows')!;
  const workflowDetail = createRoute({ getParentRoute: () => shell, path: '/workflows/$id', component: () => <Guarded item={workflowItem}><WorkflowPage /></Guarded> });
  const testCaseItem = NAV_ITEMS.find((i) => i.id === 'test-cases')!;
  const testCaseDetail = createRoute({ getParentRoute: () => shell, path: '/test-cases/$id', component: () => <Guarded item={testCaseItem}><TestCasePage /></Guarded> });
  const testCollectionDetail = createRoute({ getParentRoute: () => shell, path: '/test-collections/$id', component: () => <Guarded item={testCaseItem}><TestCollectionPage /></Guarded> });

  return createRouter({ routeTree: root.addChildren([signInError, shell.addChildren([...pages, executions, connectorNew, connectorDetail, environmentDetail, workflowDetail, testCaseDetail, testCollectionDetail])]), history: opts.history, defaultPreload: false });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
