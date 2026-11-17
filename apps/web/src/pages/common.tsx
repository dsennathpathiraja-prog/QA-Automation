import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {description && <p className="mt-1 text-slate-600 dark:text-slate-300">{description}</p>}
    </header>
  );
}

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section aria-label={label} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {children}
    </section>
  );
}

export function ComingSoon({ title, summary, phase }: { title: string; summary: string; phase: number }) {
  return (
    <>
      <PageHeader title={title} description={summary} />
      <Card label="Availability">
        <p>
          This screen is delivered in <strong>Phase {phase}</strong> of the roadmap and is not available yet. Nothing here is broken; your access to it is already
          decided by your role.
        </p>
        <p className="mt-3">
          <Link to="/" className="text-blue-700 underline dark:text-blue-300">
            Back to the dashboard
          </Link>
        </p>
      </Card>
    </>
  );
}

export function AccessDenied({ title }: { title: string }) {
  return (
    <>
      <PageHeader title="You do not have access to this page" />
      <Card label="Access">
        <p>
          <strong>{title}</strong> is not part of your role. If you need it, ask an Administrator to review which identity group you belong to.
        </p>
        <p className="mt-3">
          <Link to="/" className="text-blue-700 underline dark:text-blue-300">
            Back to the dashboard
          </Link>
        </p>
      </Card>
    </>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
      <p>{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 rounded border border-red-400 px-3 py-1 text-sm">
          Try again
        </button>
      )}
    </div>
  );
}
