import type { QueueSnapshot, OriginRelayPage } from './deliveries';

export type CapabilityState = 'available' | 'degraded' | 'unavailable' | 'unknown';

/** Fields here are observations signed/derived by the server, never client authority. */
export interface PresenceLease {
  tenant_id?: string | null;
  alias?: string | null;
  instance_id?: string | null;
  epoch?: number | null;
  capabilities?: string[] | null;
  last_heartbeat_at?: string | null;
  lease_expires_at?: string | null;
  lease_until?: string | null;
  online?: boolean | null;
}

export interface SystemStatus {
  version?: string | null;
  auth_provider?: string | null;
  online?: number | null;
  queued?: number | null;
  dead_letters?: number | null;
  outbox_pending?: number | null;
  presence?: PresenceLease[] | null;
}

export interface TerminalCapability {
  available: boolean;
  plugin_id?: string | null;
  capabilities?: string[] | null;
  websocket_path?: string | null;
  target_label?: string | null;
  reason?: string | null;
}

export interface ObservabilitySnapshot {
  observed_at?: string | null;
  status?: Record<string, unknown> | null;
  queues?: QueueSnapshot | null;
  origin_relays?: OriginRelayPage | null;
}
