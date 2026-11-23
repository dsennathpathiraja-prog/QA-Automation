import { CreateProjectRequest, ProjectListResponse, ProjectSummarySchema, type ProjectSummary } from '@qa/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useApi } from '../api/context';
import { useSession } from '../auth/session';
import { projectsKey, useProject } from '../project/ProjectContext';
import { Card, ErrorNotice, PageHeader } from './common';
import { Field, errorText, fieldClass, primaryButtonClass } from './connectors/shared';

export function Projects() {
  const api = useApi();
  const session = useSession();
  const { selectedId, select } = useProject();
  const manage = session.can('project.manage');
  const q = useQuery({ queryKey: projectsKey, queryFn: () => api.get('/api/v1/projects', ProjectListResponse) });

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project holds connectors, environments, workflows, test cases, and executions. Select one before publishing or running."
      />
      <div className="space-y-4">
        {manage && <NewProject />}
        <Card label="Projects">
          {q.isError && <ErrorNotice message="The project list could not be loaded." onRetry={() => void q.refetch()} />}
          {q.data && q.data.items.length === 0 && <p>No projects yet. Create one to configure connectors and environments.</p>}
          {q.data && q.data.items.length > 0 && (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Projects</caption>
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4">Name</th>
                  <th scope="col" className="py-2 pr-4">Key</th>
                  <th scope="col" className="py-2 pr-4">Status</th>
                  <th scope="col" className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((p) => (
                  <ProjectRow key={p.id} project={p} selected={p.id === selectedId} onSelect={() => select(p.id)} />
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {selectedId && <ProjectSetup projectId={selectedId} />}
      </div>
    </>
  );
}

function ProjectRow({ project, selected, onSelect }: { project: ProjectSummary; selected: boolean; onSelect: () => void }) {
  return (
    <tr className="border-b border-slate-100 last:border-0 dark:border-slate-800">
      <td className="py-2 pr-4">
        <span className="font-medium">{project.name}</span>
        {selected && <span className="ml-2 text-xs text-slate-500">(selected)</span>}
        {project.description ? <div className="text-xs text-slate-500">{project.description}</div> : null}
      </td>
      <td className="py-2 pr-4 font-mono text-xs">{project.key}</td>
      <td className="py-2 pr-4">{project.status}</td>
      <td className="py-2">
        {!selected && project.status === 'active' && (
          <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800" onClick={onSelect}>
            Select
          </button>
        )}
      </td>
    </tr>
  );
}

function NewProject() {
  const api = useApi();
  const qc = useQueryClient();
  const { select } = useProject();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const add = useMutation({
    mutationFn: (body: { name: string; key?: string; description?: string }) => {
      const parsed = CreateProjectRequest.parse(body);
      return api.post('/api/v1/projects', parsed, ProjectSummarySchema);
    },
    onSuccess: async (created) => {
      await qc.invalidateQueries({ queryKey: projectsKey });
      select(created.id);
      setName('');
      setKey('');
      setDescription('');
    },
  });
  return (
    <Card label="New project">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ name, key: key.trim() || undefined, description: description.trim() || undefined });
        }}
      >
        <Field id="project-name" label="Name">
          <input id="project-name" required className={fieldClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field id="project-key" label="Key" hint="Optional slug. Generated from the name when left blank.">
          <input id="project-key" className={fieldClass} value={key} onChange={(e) => setKey(e.target.value)} placeholder="my-app" />
        </Field>
        <Field id="project-desc" label="Description">
          <input id="project-desc" className={fieldClass} value={description} onChange={(e) => setDescription(e.target.value)} />
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

function ProjectSetup({ projectId }: { projectId: string }) {
  return (
    <Card label="Project setup">
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
        Configure connectors and environments for this project. Workflows, test cases, and executions use the selected project.
      </p>
      <ul className="list-inside list-disc space-y-1 text-sm">
        <li>
          <Link to="/connectors" className="text-blue-700 underline dark:text-blue-300">
            Connectors
          </Link>{' '}
          — place and test systems for this project
        </li>
        <li>
          <Link to="/environments" className="text-blue-700 underline dark:text-blue-300">
            Environments
          </Link>{' '}
          — application URLs and auth for this project
        </li>
        <li>
          <Link to="/workflows" className="text-blue-700 underline dark:text-blue-300">
            Workflows
          </Link>{' '}
          — publish after the project is selected (follow-up: project-scoped publish)
        </li>
        <li>
          <Link to="/test-cases" className="text-blue-700 underline dark:text-blue-300">
            Test cases
          </Link>{' '}
          — generate and store in project scope (follow-up)
        </li>
        <li>
          <Link to="/executions" className="text-blue-700 underline dark:text-blue-300">
            Executions
          </Link>{' '}
          — select project, then run published workflows (follow-up)
        </li>
      </ul>
      <p className="mt-3 font-mono text-xs text-slate-500">projectId={projectId}</p>
    </Card>
  );
}
