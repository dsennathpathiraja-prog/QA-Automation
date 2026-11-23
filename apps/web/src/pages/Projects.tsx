import { CreateProjectRequest, ProjectListResponse, ProjectSummarySchema, type ProjectSummary } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { projectsKey, useProject } from '../project/ProjectContext';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

export function Projects() {
  const api = useApi();
  const session = useSession();
  const { selected, selectedId, select } = useProject();
  const manage = session.can('project.manage');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: projectsKey, queryFn: () => api.get('/api/v1/projects', ProjectListResponse) });

  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/projects/${id}/archive`, undefined, ProjectSummarySchema),
    onSuccess: async (updated) => {
      await qc.invalidateQueries({ queryKey: projectsKey });
      if (selectedId === updated.id) {
        const next = (q.data?.items ?? []).find((p) => p.id !== updated.id && p.status === 'active');
        select(next?.id);
      }
    },
  });

  return (
    <>
      <PageHeader title="Projects" description="Select a project, or create a new empty one." />
      <div className="space-y-4">
        <Card label="Selected project">
          {selected ? (
            <p className="text-lg font-semibold">{selected.name}</p>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-300">No project selected.</p>
          )}
        </Card>

        {manage && <NewProject />}

        <Card label="All projects">
          {q.isError && <ErrorNotice message="The project list could not be loaded." onRetry={() => void q.refetch()} />}
          {q.data && q.data.items.length === 0 && <p>No projects yet.</p>}
          {q.data && q.data.items.length > 0 && (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.items.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  selected={p.id === selectedId}
                  canManage={manage}
                  onSelect={() => select(p.id)}
                  onArchive={() => archive.mutate(p.id)}
                  archivePending={archive.isPending}
                />
              ))}
            </ul>
          )}
          {archive.isError && (
            <div className="mt-3">
              <ErrorNotice message={errorText(archive.error, 'The project could not be archived.')} />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ProjectRow({
  project,
  selected,
  canManage,
  onSelect,
  onArchive,
  archivePending,
}: {
  project: ProjectSummary;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onArchive: () => void;
  archivePending: boolean;
}) {
  return (
    <li className={`flex flex-wrap items-center justify-between gap-2 py-3 ${selected ? 'bg-blue-50/60 dark:bg-blue-950/30' : ''}`}>
      <div>
        <span className="font-medium">{project.name}</span>
        {selected && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-200">Selected</span>}
        {project.status === 'archived' && <span className="ml-2 text-xs text-slate-500">Archived</span>}
      </div>
      <div className="flex gap-2">
        {!selected && project.status === 'active' && (
          <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800" onClick={onSelect}>
            Select
          </button>
        )}
        {canManage && project.status === 'active' && project.key !== 'default' && (
          <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800" disabled={archivePending} onClick={onArchive}>
            Archive
          </button>
        )}
      </div>
    </li>
  );
}

function NewProject() {
  const api = useApi();
  const qc = useQueryClient();
  const { select } = useProject();
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: (body: { name: string }) => api.post('/api/v1/projects', CreateProjectRequest.parse(body), ProjectSummarySchema),
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: projectsKey });
      select(created.id);
      setName('');
    },
  });
  return (
    <Card label="New project">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">Creates an empty project. Connectors and environments are added after you select it.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ name });
        }}
      >
        <Field id="project-name" label="Name">
          <input id="project-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <button type="submit" className={`${primaryButtonClass} mt-3`} disabled={add.isPending}>
          Create project
        </button>
        {add.isError && (
          <div className="mt-3">
            <ErrorNotice message={errorText(add.error, 'The project could not be created.')} />
          </div>
        )}
      </form>
    </Card>
  );
}
