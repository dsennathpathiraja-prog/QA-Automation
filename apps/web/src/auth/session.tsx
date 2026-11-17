import { LogoutResponse, MePermissionsResponse, type Permission, type Role } from '@qa/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useApi } from '../api/context';

export interface Session {
  userId: string;
  displayName: string;
  roles: readonly Role[];
  can(permission: Permission): boolean;
  canAny(permissions: readonly Permission[] | undefined): boolean;
  signOut(): Promise<void>;
}

const Ctx = createContext<Session | undefined>(undefined);
export const useSession = (): Session => {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionGate is missing');
  return s;
};

export interface Navigator {
  /** Full-page navigation (login redirect, IdP logout). Injected so tests do not touch window.location. */
  assign(url: string): void;
  currentPath(): string;
}

export const browserNavigator: Navigator = {
  assign: (url) => window.location.assign(url),
  currentPath: () => window.location.pathname + window.location.search,
};

export const loginUrl = (returnTo: string) => `/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

/** Renders children only for a signed-in user; otherwise sends the browser to the IdP via the API. */
export function SessionGate({ children, navigator = browserNavigator }: { children: ReactNode; navigator?: Navigator }) {
  const api = useApi();
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get('/api/v1/me', MePermissionsResponse),
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
    staleTime: 60_000,
  });

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) navigator.assign(loginUrl(navigator.currentPath()));
  }, [unauthenticated, navigator]);

  const signOut = useCallback(async () => {
    const out = await api.post('/api/v1/auth/logout', {}, LogoutResponse).catch(() => undefined);
    qc.clear();
    navigator.assign(out?.logoutUrl ?? '/');
  }, [api, qc, navigator]);

  const data = me.data;
  const value = useMemo<Session | undefined>(() => {
    if (!data) return undefined;
    const set = new Set<string>(data.permissions);
    return {
      userId: data.userId,
      displayName: data.displayName,
      roles: data.roles,
      can: (p) => set.has(p),
      canAny: (ps) => !ps || ps.length === 0 || ps.some((p) => set.has(p)),
      signOut,
    };
  }, [data, signOut]);

  if (value) return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  if (unauthenticated) return <Status title="Redirecting to sign-in" detail="You need to sign in to continue." />;
  if (me.isError) {
    return (
      <Status
        title="The platform is unreachable"
        detail="We could not load your session. Check your connection and try again; if it persists, contact an Administrator."
        action={{ label: 'Try again', onClick: () => void me.refetch() }}
      />
    );
  }
  return <Status title="Loading" detail="Checking your session." busy />;
}

function Status({ title, detail, busy, action }: { title: string; detail: string; busy?: boolean; action?: { label: string; onClick(): void } }) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="max-w-md text-center" role="status" aria-busy={busy ? 'true' : 'false'}>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">{detail}</p>
        {action && (
          <button type="button" onClick={action.onClick} className="mt-4 rounded-md bg-blue-700 px-4 py-2 text-white hover:bg-blue-800">
            {action.label}
          </button>
        )}
      </div>
    </main>
  );
}
