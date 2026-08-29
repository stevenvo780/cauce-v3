export type ConsolePermission =
  | 'message.publish' | 'delivery.replay' | 'delivery.cancel' | 'job.create' | 'config.write'
  | 'config.rollback' | 'dlq.resolve' | 'ultimate-terminal.connect';

/**
 * `password` = the gateway asks for email and password in its own form (POST /v3/auth/login).
 * `redirect` = the browser must be sent to /v3/auth/login (BFF OIDC). Absent is read as
 * `redirect`, which is how the console behaved before password login existed: an old gateway
 * keeps working by not knowing this field.
 */
export type LoginMode = 'password' | 'redirect';

export interface ConsoleAuthState {
  /** null means the selected legacy auth mode has no BFF session facade. */
  authenticated: boolean | null;
  login_mode?: LoginMode | null;
  subject?: string | null;
  name?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
  expires_at?: string | null;
  csrf_token?: string | null;
  reason?: string | null;
}

/** Server-derived RBAC snapshot. Missing permissions are UNKNOWN, never implicitly allowed. */
export interface ConsoleAccess {
  subject?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
  observed_at?: string | null;
  reason?: string | null;
}
