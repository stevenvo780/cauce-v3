export interface ProviderAuthActor { tenant_id: string; alias: string; subject: string }
export interface ProviderAuthRequest {
  operation_id: string;
  expected_operation_version: number;
  request_id: string;
  provider_id: 'codex' | 'claude' | 'gemini' | 'minimax' | 'grok' | 'feihoa';
  account_id: string;
  harness_id: string;
  host_id: string;
  runtime_user: string;
  profile_id: string;
}
export type ProviderAuthStatus = 'opening' | 'awaiting_login' | 'verifying' | 'authenticated' | 'cancelled' | 'expired' | 'failed';
export type ProviderAuthCode = 'AUTHORITY_REVOKED' | 'SESSION_CONFLICT' | 'INVALID_REQUEST' | 'HOST_UNAVAILABLE'
  | 'STOP_UNCONFIRMED' | 'IDENTITY_MISMATCH' | 'FUNCTIONAL_CHECK_FAILED' | 'LOGIN_FAILED' | 'SESSION_EXPIRED';
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
  verify(signal: AbortSignal): Promise<{ identity_matches: boolean; functional_call_verified: boolean }>;
  release(): Promise<void>;
}
export interface ProviderAuthDependencies {
  authorize(actor: ProviderAuthActor, request: ProviderAuthRequest): Promise<void>;
  reserve(actor: ProviderAuthActor, request: ProviderAuthRequest, sessionId: string, expiresAt: string): Promise<ProviderAuthReservation>;
  audit(metadata: { actor_subject: string; session_id: string; operation_id: string; status: ProviderAuthStatus; error: ProviderAuthCode | null }): Promise<void>;
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
