export type ConsolePermission =
  | 'message.publish' | 'delivery.replay' | 'delivery.cancel' | 'job.create' | 'config.write'
  | 'config.rollback' | 'dlq.resolve' | 'ultimate-terminal.connect';

/**
 * `password` = the gateway asks for email and password in its own form (POST /v3/auth/login).
 * `redirect` = the browser must be sent to /v3/auth/login (BFF OIDC). Absent is read as
 * `redirect`, which is how the console behaved before password login existed: an old gateway
 * keeps working by not knowing this field.
 */
type LoginMode = 'password' | 'redirect';

export type ConsoleAuthorityRole =
  | 'platform_admin' | 'company_owner' | 'company_admin' | 'tenant_operator' | 'reader' | 'none';
export type ConsoleAuthorityScope = 'platform' | 'company' | 'tenant' | 'outgoing_acl' | 'none';

export interface ConsoleAuthority {
  role: ConsoleAuthorityRole;
  scope: ConsoleAuthorityScope;
  home_company: string;
  acting_company: string;
  platform_override: boolean;
}

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
  authority?: ConsoleAuthority | null;
}

/** Server-derived RBAC snapshot. Missing permissions are UNKNOWN, never implicitly allowed. */
export interface ConsoleAccess {
  subject?: string | null;
  human_subject?: string | null;
  roles?: string[] | null;
  permissions?: string[] | null;
  observed_at?: string | null;
  reason?: string | null;
}
