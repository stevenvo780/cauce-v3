// Types for ./fake-gateway.mjs.

export interface FakeGatewayOptions {
  host?: string;
  port?: number;
  relay_token?: string;
  master_key_b64?: string;
  operator_tenant?: string;
  clock_skew_sec?: number;
  now?: () => number;
  grants?: string[];
  plaintext?: boolean;
  tls_key?: Buffer;
  tls_cert?: Buffer;
  /** Flips authz to 403 revoked this long after a successful consume. */
  revoke_after_ms?: number;
  /** Makes the gateway unreachable this long after start, to test fail-closed. */
  down_after_ms?: number;
  down_mode?: 'reset' | 'timeout' | '503';
}

export interface FakeGatewayAuditEntry {
  at: string;
  event: string;
  [field: string]: unknown;
}

export interface FakeGatewaySession {
  session_id: string;
  tenant_id: string;
  alias: string;
  container_id: string;
  generation: string;
  image_id: string;
  runtime_user: string;
  runtime_uid: number;
  mode: string;
  subject: string;
  operation: string;
  expires_at: number;
  session_expires_at: number;
  consumed_at: number;
  ticket_fp: string;
  resume_token: string;
  revoked_at: number | null;
  closed_at: number | null;
}

export interface FakeGatewayHandle {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly ca?: Buffer;
  readonly ca_path?: string;
  readonly audit: FakeGatewayAuditEntry[];
  readonly agents: Record<string, unknown>[];
  readonly sessions: FakeGatewaySession[];
  session(sessionId: string): FakeGatewaySession | undefined;
  setGrants(next: string[]): void;
  revokeAll(): void;
  restore(): void;
  goDown(): void;
  auditOf(event: string): FakeGatewayAuditEntry[];
  close(): Promise<void>;
}

export declare function startFakeGateway(options?: FakeGatewayOptions): Promise<FakeGatewayHandle>;
