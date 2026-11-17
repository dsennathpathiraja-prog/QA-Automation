/** Claims the platform trusts after the IdP's ID token has been fully verified. */
export interface VerifiedIdentity {
  subject: string;
  displayName: string;
  email?: string;
  groups: string[];
  /** IdP session id (`sid`), used for back-channel logout. */
  idpSessionId?: string;
  /** Kept server-side only, for RP-initiated logout. */
  idToken: string;
}

export interface LoginStart {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/**
 * Authentication only. Authorization is derived from internal roles, so any OIDC-compliant IdP
 * (Keycloak, Entra ID brokered or direct, others) can sit behind this port.
 */
export interface OidcIdentityProvider {
  startLogin(redirectUri: string): Promise<LoginStart>;
  completeLogin(input: { code: string; redirectUri: string; codeVerifier: string; nonce: string }): Promise<VerifiedIdentity>;
  /** Verifies an OIDC back-channel logout token and returns the sessions it refers to. Throws if invalid. */
  verifyLogoutToken(token: string): Promise<{ idpSessionId?: string; subject?: string }>;
  endSessionUrl(idToken: string, postLogoutRedirectUri: string): Promise<string | undefined>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  displayName: string;
  email?: string;
  groups: string[];
  roles: string[];
  csrfToken: string;
  idToken: string;
  idpSessionId?: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface SessionStore {
  create(rec: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  touch(id: string, now: number): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByIdpSession(idpSessionId: string): Promise<number>;
  deleteByUser(userId: string): Promise<number>;
}
