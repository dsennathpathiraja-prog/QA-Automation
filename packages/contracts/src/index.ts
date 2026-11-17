import { z } from 'zod';
import { PERMISSIONS, ROLES } from '@qa/domain';

export const RoleSchema = z.enum(ROLES);
export const PermissionSchema = z.enum(PERMISSIONS);

export const MePermissionsResponse = z.object({
  userId: z.string(),
  displayName: z.string(),
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
});
export type MePermissionsResponse = z.infer<typeof MePermissionsResponse>;

export const HealthResponse = z.object({ status: z.enum(['ok', 'degraded']), profile: z.string() });
export type HealthResponse = z.infer<typeof HealthResponse>;

export const ErrorResponse = z.object({
  error: z.object({ class: z.string(), message: z.string(), requestId: z.string().optional() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
