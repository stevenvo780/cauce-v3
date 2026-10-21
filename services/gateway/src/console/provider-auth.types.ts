export interface ProviderAuthActor { tenant_id: string; alias: string; subject: string; requestedCompany?: string }
export interface ProviderAuthRequest {
  operation_id: string;
  expected_operation_version: number;
  request_id: string;
  provider_id: 'codex' | 'claude' | 'gemini' | 'minimax' | 'grok' | 'feihoa' | 'muse' | 'agy';
  account_id: string;
  harness_id: string;
  host_id: string;
  runtime_user: string;
  profile_id: string;
}
export type ProviderAuthStatus = 'opening' | 'awaiting_login' | 'verifying' | 'authenticated' | 'cancelled' | 'expired' | 'failed';
export type ProviderAuthCode = 'AUTHORITY_REVOKED' | 'SESSION_CONFLICT' | 'INVALID_REQUEST' | 'HOST_UNAVAILABLE'
  | 'RUNTIME_DRIFT' | 'STOP_UNCONFIRMED' | 'IDENTITY_MISMATCH' | 'FUNCTIONAL_CHECK_FAILED' | 'LOGIN_FAILED' | 'SESSION_EXPIRED';
export type ProviderAuthDriftReason = 'CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT' | 'CONTAINER_RESOURCE_LIMITS_DRIFT' | 'CONTAINER_ISOLATION_DRIFT';
/** Why the identity probe of a provider login failed; bounded and secret-free (ops/cli/fleet_provider_identity.py). */
export type ProviderAuthProbeReason = 'PROBE_TIMEOUT' | 'PROBE_EXIT' | 'PROBE_BAD_JSON' | 'PROBE_NONCE_MISMATCH' | 'PROBE_OUTPUT_LIMIT' | 'PROBE_UNAVAILABLE' | 'PROBE_IDENTITY_MISMATCH' | 'PROBE_IDENTITY_UNAVAILABLE' | 'PROBE_PROFILE_UNUSABLE' | 'PROBE_VERSION_MISMATCH' | 'PROBE_CONFIG_SCOPE' | 'PROBE_CONTAINER_EXEC_FAILED';
export type ProviderAuthReason = ProviderAuthDriftReason | ProviderAuthProbeReason;
export interface ProviderAuthSnapshot {
  session_id: string;
  operation_id: string;
  provider_id: ProviderAuthRequest['provider_id'];
  account_id: string;
  harness_id: string;
  host_id: string;
  runtime_user: string;
  profile_id: string;
  method: 'device' | 'terminal';
  status: ProviderAuthStatus;
  expires_at: string;
  cleanup_pending: boolean;
  error: ProviderAuthCode | null;
  reason?: ProviderAuthReason;
}
export interface ProviderAuthLogin {
  readonly method: 'device' | 'terminal';
  subscribeOutput(listener: (bytes: Uint8Array) => void): () => void;
  start(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<{ stopped: boolean }>;
}
export interface ProviderAuthReservation {
  stopAdapter(signal: AbortSignal): Promise<{ stopped: boolean }>;
  openLogin(signal: AbortSignal): Promise<ProviderAuthLogin>;
  verify(signal: AbortSignal): Promise<{ identity_matches: boolean; functional_call_verified: boolean; reason?: ProviderAuthReason }>;
  release(): Promise<void>;
}
export interface ProviderAuthDependencies {
  authorize(actor: ProviderAuthActor, request: ProviderAuthRequest): Promise<void>;
  expiration?(actor: ProviderAuthActor, request: ProviderAuthRequest, maximum: string): Promise<string>;
  reserve(actor: ProviderAuthActor, request: ProviderAuthRequest, sessionId: string, expiresAt: string): Promise<ProviderAuthReservation>;
  audit(metadata: { actor_subject: string; session_id: string; operation_id: string; status: ProviderAuthStatus; error: ProviderAuthCode | null; reason?: ProviderAuthReason }): Promise<void>;
}
export interface ProviderAuthChannel {
  input(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
export type ProviderAuthService = Pick<import('./provider-auth.sessions.js').ProviderAuthManager,
  'start' | 'get' | 'verify' | 'cancel' | 'issueSocketTicket' | 'consumeSocketTicket' | 'attach' | 'revokeOperation' | 'shutdown'> & {
    resolve?(actor: ProviderAuthActor, operationId: string): Promise<ProviderAuthRequest>;
  };
