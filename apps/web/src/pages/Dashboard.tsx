import { useSession } from '../auth/session';
import { visibleNav } from '../nav';
import { Card, PageHeader } from './common';
import { Link } from '@tanstack/react-router';

export function Dashboard() {
  const s = useSession();
  const items = visibleNav(s.canAny).filter((i) => i.id !== 'dashboard');
  return (
    <>
      <PageHeader title={`Welcome, ${s.displayName}`} description="What would you like to do?" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card label="Where you can go">
          <h2 className="font-semibold">Available to you</h2>
          <ul className="mt-2 space-y-1">
            {items.map((i) => (
              <li key={i.id}>
                <Link to={i.to} className="text-blue-700 underline dark:text-blue-300">
                  {i.label}
                </Link>
                <span className="text-sm text-slate-600 dark:text-slate-400"> {i.summary}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card label="Platform status">
          <h2 className="font-semibold">Getting started</h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            The platform foundation is in place. Connectors, environments and workflows are being delivered in the next phases, and this page will then show runs,
            approvals and connector health.
          </p>
        </Card>
      </div>
    </>
  );
}
