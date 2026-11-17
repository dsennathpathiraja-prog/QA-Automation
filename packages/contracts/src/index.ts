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

export type Permission = z.infer<typeof PermissionSchema>;
export type Role = z.infer<typeof RoleSchema>;

export const SessionResponse = z.object({ csrfToken: z.string(), expiresAt: z.string() });
export type SessionResponse = z.infer<typeof SessionResponse>;

export const IdentityMappingsResponse = z.object({
  items: z.array(z.object({ idpGroup: z.string(), role: RoleSchema, enabled: z.boolean() })),
});
export type IdentityMappingsResponse = z.infer<typeof IdentityMappingsResponse>;

export const ConnectorListResponse = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), providerKey: z.string(), status: z.string() })) });
export type ConnectorListResponse = z.infer<typeof ConnectorListResponse>;
export type { ZodType } from 'zod';

export const LogoutResponse = z.object({ loggedOut: z.boolean(), logoutUrl: z.string().nullable() });
export type LogoutResponse = z.infer<typeof LogoutResponse>;

export const LlmProvidersResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['local', 'external']),
      adapter: z.string(),
      enabled: z.boolean(),
      health: z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string().optional() }),
      models: z.array(
        z.object({
          name: z.string(),
          contextTokens: z.number().optional(),
          supportsToolCalling: z.boolean().optional(),
          supportsStructuredOutput: z.boolean().optional(),
          supportsVision: z.boolean().optional(),
        }),
      ),
    }),
  ),
});
export type LlmProvidersResponse = z.infer<typeof LlmProvidersResponse>;
