import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useProject } from '../project/ProjectContext';
import { Card, PageHeader } from './common';
import { primaryButtonClass } from './connectors/shared';

/** Structural gate: workflows, cases, and executions require a selected project. */
export function RequireProject({ title, children }: { title: string; children: ReactNode }) {
  const { selected, loading, error, refetch } = useProject();
  if (loading) return <p role="status">Loading projects…</p>;
  if (error) {
    return (
      <>
        <PageHeader title={title} description="A project is required." />
        <Card label="Projects unavailable">
          <p>Projects could not be loaded.</p>
          <button type="button" className={`${primaryButtonClass} mt-3`} onClick={() => refetch()}>
            Retry
          </button>
        </Card>
      </>
    );
  }
  if (!selected) {
    return (
      <>
        <PageHeader title={title} description="Select a project before continuing." />
        <Card label="No project selected">
          <p>Create or select a project first. Connectors, environments, and workflows are scoped to that project.</p>
          <p className="mt-3">
            <Link to="/projects" className={primaryButtonClass}>
              Go to Projects
            </Link>
          </p>
        </Card>
      </>
    );
  }
  return <>{children}</>;
}
