export type ConsolePermission =
  | 'message.publish' | 'delivery.replay' | 'delivery.cancel' | 'job.create' | 'config.write'
  | 'config.rollback' | 'dlq.resolve' | 'ultimate-terminal.connect';

/**
 * `password` = el gateway pide correo y contraseña en su propio formulario (POST /v3/auth/login).
 * `redirect` = hay que mandar al navegador a /v3/auth/login (BFF OIDC). Ausente se lee como
 * `redirect`, que es como se comportaba la consola antes de que existiera el login por
 * contraseña: un gateway viejo no deja de funcionar por no conocer este campo.
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
