import { Link, Outlet, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { SessionGate, useSession, type Navigator } from './auth/session';
import { AppShell } from './layout/AppShell';
import { NAV_ITEMS, type NavItem } from './nav';
import { AccessDenied, ComingSoon, PageHeader } from './pages/common';
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
import { Projects } from './pages/Projects';
import { RequireProject } from './pages/RequireProject';
import { ReportEvidence } from './pages/ReportEvidence';
import { RunDetailPage } from './pages/RunDetailPage';
import { SignInError } from './pages/SignInError';
import { ProjectProvider } from './project/ProjectContext';

function Guarded({ item, children }: { item: NavItem; children?: ReactNode }) {
  const s = useSession();
  if (!s.canAny(item.anyOf)) return <AccessDenied title={item.label} />;
  return <>{children ?? <ComingSoon title={item.label} summary={item.summary} phase={item.phase} />}</>;
}

function reportEvidenceSearch(s: Record<string, unknown>) {
  return {
    focus: typeof s.focus === 'string' && s.focus.trim() ? s.focus.trim() : undefined,
    view: s.view === 'summary' || s.view === 'report' || s.view === 'evidence' ? (s.view as 'summary' | 'report' | 'evidence') : undefined,
    case: typeof s.case === 'string' && s.case.trim() ? s.case.trim() : undefined,
  };
}

const NotFound = () => (
  <>
    <PageHeader title="Page not found" description="That address does not exist." />
    <Link to="/" className="text-blue-700 underline dark:text-blue-300">
      Back to the dashboard
    </Link>
  </>
);

const real: Record<string, () => ReactNode> = {
  dashboard: () => <Dashboard />,
  workflows: () => (
    <RequireProject title="Workflows">
      <Workflows />
    </RequireProject>
  ),
  executions: () => (
    <RequireProject title="Executions">
      <Executions />
    </RequireProject>
  ),
  'test-cases': () => (
    <RequireProject title="Test Cases">
      <TestCases />
    </RequireProject>
  ),
  evidence: () => <ReportEvidence mode="evidence" />,
  reports: () => <ReportEvidence mode="report" />,
  projects: () => <Projects />,
  connectors: () => (
    <RequireProject title="Connectors">
      <Connectors />
    </RequireProject>
  ),
  environments: () => (
    <RequireProject title="Environments">
      <Environments />
    </RequireProject>
  ),
  identity: () => <IdentityMapping />,
  hosts: () => <ApprovedHosts />,
};

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
        <ProjectProvider>
          <AppShell />
        </ProjectProvider>
      </SessionGate>
    ),
    notFoundComponent: NotFound,
  });

  const pages = NAV_ITEMS.filter((item) => item.id !== 'executions' && item.id !== 'evidence' && item.id !== 'reports').map((item) =>
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
    validateSearch: (s: Record<string, unknown>) => ({
      tab: s.tab === 'history' || s.tab === 'prepared' ? (s.tab as 'history' | 'prepared') : undefined,
      ...reportEvidenceSearch(s),
    }),
    component: () => (
      <Guarded item={executionsItem}>
        <RequireProject title="Executions">
          <Executions />
        </RequireProject>
      </Guarded>
    ),
  });
  const evidenceItem = NAV_ITEMS.find((item) => item.id === 'evidence')!;
  const evidence = createRoute({
    getParentRoute: () => shell,
    path: '/evidence',
    validateSearch: reportEvidenceSearch,
    component: () => (
      <Guarded item={evidenceItem}>
        <RequireProject title="Evidence">
          <ReportEvidence mode="evidence" />
        </RequireProject>
      </Guarded>
    ),
  });
  const reportsItem = NAV_ITEMS.find((item) => item.id === 'reports')!;
  const reports = createRoute({
    getParentRoute: () => shell,
    path: '/reports',
    validateSearch: reportEvidenceSearch,
    component: () => (
      <Guarded item={reportsItem}>
        <RequireProject title="Reports">
          <ReportEvidence mode="report" />
        </RequireProject>
      </Guarded>
    ),
  });
  const runDetail = createRoute({
    getParentRoute: () => shell,
    path: '/runs/$id',
    validateSearch: (s: Record<string, unknown>) => ({
      view: s.view === 'summary' || s.view === 'report' || s.view === 'evidence' ? (s.view as 'summary' | 'report' | 'evidence') : undefined,
      case: typeof s.case === 'string' && s.case.trim() ? s.case.trim() : undefined,
      from: s.from === 'reports' || s.from === 'evidence' || s.from === 'executions' ? (s.from as 'reports' | 'evidence' | 'executions') : undefined,
    }),
    component: () => <RunDetailPage />,
  });

  const connectorItem = NAV_ITEMS.find((i) => i.id === 'connectors')!;
  const manageItem: NavItem = { ...connectorItem, anyOf: ['connector.manage'] };
  const connectorNew = createRoute({
    getParentRoute: () => shell,
    path: '/connectors/new',
    component: () => (
      <Guarded item={manageItem}>
        <RequireProject title="Add connector">
          <ConnectorWizard />
        </RequireProject>
      </Guarded>
    ),
  });
  const connectorDetail = createRoute({ getParentRoute: () => shell, path: '/connectors/$id', component: () => <Guarded item={connectorItem}><ConnectorDetailPage /></Guarded> });
  const environmentItem = NAV_ITEMS.find((i) => i.id === 'environments')!;
  const environmentDetail = createRoute({ getParentRoute: () => shell, path: '/environments/$id', component: () => <Guarded item={environmentItem}><EnvironmentPage /></Guarded> });
  const workflowItem = NAV_ITEMS.find((i) => i.id === 'workflows')!;
  const workflowDetail = createRoute({
    getParentRoute: () => shell,
    path: '/workflows/$id',
    component: () => (
      <Guarded item={workflowItem}>
        <RequireProject title="Workflow">
          <WorkflowPage />
        </RequireProject>
      </Guarded>
    ),
  });
  const testCaseItem = NAV_ITEMS.find((i) => i.id === 'test-cases')!;
  const testCaseDetail = createRoute({
    getParentRoute: () => shell,
    path: '/test-cases/$id',
    component: () => (
      <Guarded item={testCaseItem}>
        <RequireProject title="Test case">
          <TestCasePage />
        </RequireProject>
      </Guarded>
    ),
  });
  const testCollectionDetail = createRoute({
    getParentRoute: () => shell,
    path: '/test-collections/$id',
    component: () => (
      <Guarded item={testCaseItem}>
        <RequireProject title="Test collection">
          <TestCollectionPage />
        </RequireProject>
      </Guarded>
    ),
  });

  return createRouter({ routeTree: root.addChildren([signInError, shell.addChildren([...pages, executions, evidence, reports, runDetail, connectorNew, connectorDetail, environmentDetail, workflowDetail, testCaseDetail, testCollectionDetail])]), history: opts.history, defaultPreload: false });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
