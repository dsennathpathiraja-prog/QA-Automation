import { ProjectListResponse, type ProjectSummary } from '@qa/contracts';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../api/context';

const STORAGE_KEY = 'qa.selectedProjectId';

export const projectsKey = ['projects'] as const;

interface ProjectContextValue {
  projects: ProjectSummary[];
  selected: ProjectSummary | undefined;
  selectedId: string | undefined;
  select: (id: string | undefined) => void;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || undefined;
    } catch {
      return undefined;
    }
  });
  const q = useQuery({
    queryKey: projectsKey,
    queryFn: () => api.get('/api/v1/projects?status=active', ProjectListResponse),
  });

  const projects = q.data?.items ?? [];
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0];

  useEffect(() => {
    if (!selectedId && projects[0]) setSelectedId(projects[0].id);
  }, [projects, selectedId]);

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const select = useCallback((id: string | undefined) => {
    setSelectedId(id);
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      selected,
      selectedId: selected?.id,
      select,
      loading: q.isPending,
      error: q.isError,
      refetch: () => void q.refetch(),
    }),
    [projects, selected, select, q],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject requires ProjectProvider');
  return ctx;
}
