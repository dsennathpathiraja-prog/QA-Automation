import type { Permission } from '@qa/domain';

/** Every API route must declare one of these; the API refuses to register routes without it. */
export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission };

export const publicRoute: RouteAccess = { kind: 'public' };
export const authenticatedRoute: RouteAccess = { kind: 'authenticated' };
export const requires = (permission: Permission): RouteAccess => ({ kind: 'permission', permission });
