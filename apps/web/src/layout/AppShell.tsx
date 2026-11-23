import { Link, Outlet } from '@tanstack/react-router';
import { useState } from 'react';
import { useSession } from '../auth/session';
import { GROUP_LABEL, visibleNav, type NavGroup } from '../nav';
import { useProject } from '../project/ProjectContext';

const ROLE_LABEL: Record<string, string> = {
  administrator: 'Administrator',
  qa_lead: 'QA Lead',
  qa_engineer: 'QA Engineer',
  business_user: 'Business User',
};

export function AppShell() {
  const session = useSession();
  const project = useProject();
  const items = visibleNav(session.canAny);
  const groups = (['main', 'config', 'admin'] as NavGroup[]).map((g) => ({ g, items: items.filter((i) => i.group === g) })).filter((x) => x.items.length > 0);
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:text-slate-900">
        Skip to content
      </a>
      <aside className="border-b border-slate-200 bg-white md:w-64 md:shrink-0 md:border-b-0 md:border-r dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold">QA Platform</span>
          <button type="button" className="rounded px-2 py-1 text-sm md:hidden" aria-expanded={menuOpen} aria-controls="primary-nav" onClick={() => setMenuOpen((o) => !o)}>
            Menu
          </button>
        </div>
        <div className="border-b border-slate-100 px-4 pb-3 dark:border-slate-800">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <label htmlFor="project-select" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Project
            </label>
            <Link to="/projects" className="text-xs text-blue-700 underline dark:text-blue-300">
              Manage
            </Link>
          </div>
          {project.loading && <p className="text-xs text-slate-500">Loading…</p>}
          {!project.loading && project.projects.length === 0 && (
            <Link to="/projects" className="text-sm text-blue-700 underline dark:text-blue-300">
              Set up a project
            </Link>
          )}
          {project.projects.length > 0 && (
            <>
              <p className="mb-1 text-sm font-semibold" aria-live="polite">
                {project.selected?.name ?? 'None selected'}
              </p>
              <select
                id="project-select"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                value={project.selectedId ?? ''}
                onChange={(e) => project.select(e.target.value || undefined)}
                aria-label="Switch project"
              >
                {project.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <nav id="primary-nav" aria-label="Primary" className={`${menuOpen ? 'block' : 'hidden'} px-2 pb-4 md:block`}>
          {groups.map(({ g, items: list }) => (
            <div key={g} className="mt-3 first:mt-0">
              {g !== 'main' && <h2 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{GROUP_LABEL[g]}</h2>}
              <ul>
                {list.map((i) => (
                  <li key={i.id}>
                    <Link
                      to={i.to}
                      activeOptions={{ exact: i.to === '/' }}
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                      activeProps={{ className: 'block rounded-md px-3 py-2 text-sm bg-blue-50 font-medium text-blue-900 dark:bg-blue-950 dark:text-blue-100', 'aria-current': 'page' }}
                    >
                      {i.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-right text-sm">
            <div className="font-medium">{session.displayName}</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">{session.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</div>
          </div>
          <button type="button" onClick={() => void session.signOut()} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
            Sign out
          </button>
        </header>
        <main id="main" tabIndex={-1} className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
