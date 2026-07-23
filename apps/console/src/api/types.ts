export type DeliveryState =
  | 'pending'
  | 'leased'
  | 'accepted'
  | 'started'
  | 'done'
  | 'failed'
  | 'retry'
  | 'dead';

export type JobLane = 'interactive' | 'batch';
export type CapabilityState = 'available' | 'degraded' | 'unavailable' | 'unknown';
export type ConsolePermission =
  | 'message.publish' | 'delivery.replay' | 'job.create' | 'config.write' | 'config.rollback'
  | 'ultimate-terminal.connect';

export interface ConsoleAuthState {
  /** null means the selected legacy auth mode has no BFF session facade. */
  authenticated: boolean | null;
  subject?: string | null;
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

export interface TenantNode {
  id?: string | null;
  label?: string | null;
  rooms?: Array<{
    id?: string | null;
    label?: string | null;
    members?: Array<{ alias?: string | null; enabled?: boolean | null }> | null;
  }> | null;
}

export interface AclEdge {
  from_tenant?: string | null;
  to_tenant?: string | null;
  enabled?: boolean | null;
  policy?: string | null;
  allow_route?: boolean | null;
  allow_read?: boolean | null;
  allow_control?: boolean | null;
}

export interface TopologySnapshot {
  observed_at?: string | null;
  tenants?: TenantNode[] | null;
  acl_edges?: AclEdge[] | null;
}

export interface TimelineEvent {
  status: 'published' | Extract<DeliveryState, 'accepted' | 'started' | 'done' | 'failed'>;
  at?: string | null;
  attempt?: number | null;
  detail?: string | null;
}

export interface DeliveryView {
  delivery_id?: string | null;
  recipient_tenant?: string | null;
  recipient_alias?: string | null;
  status?: DeliveryState | null;
  attempt?: number | null;
  timeline?: TimelineEvent[] | null;
}

export interface MessageView {
  message_id?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  tenant_id?: string | null;
  room_id?: string | null;
  actor_alias?: string | null;
  body_preview?: string | null;
  lane?: JobLane | null;
  created_at?: string | null;
  deliveries?: DeliveryView[] | null;
}

export interface MessagePage {
  items?: MessageView[] | null;
  next_cursor?: string | null;
}

export interface PublishMessageInput {
  room_id: string;
  recipients: Array<{ tenant_id: string; alias: string }>;
  body: { text: string };
  lane: JobLane;
  priority: number;
  idempotency_key: string;
}

export interface PublishResult {
  message_id?: string | null;
  delivery_ids?: string[] | null;
  duplicate?: boolean | null;
  request_id?: string | null;
  trace_id?: string | null;
}

export interface QueueItem {
  delivery_id?: string | null;
  message_id?: string | null;
  tenant_id?: string | null;
  recipient_alias?: string | null;
  lane?: JobLane | null;
  state?: DeliveryState | null;
  attempts?: number | null;
  max_attempts?: number | null;
  available_at?: string | null;
  last_error?: string | null;
}

export interface QueueSnapshot {
  observed_at?: string | null;
  pending?: number | null;
  retrying?: number | null;
  dead?: number | null;
  items?: QueueItem[] | null;
}

export interface ReplayResult {
  delivery_id?: string | null;
  state?: DeliveryState | null;
  replayed?: boolean | null;
}

export interface JobView {
  job_id?: string | null;
  tenant_id?: string | null;
  lane?: JobLane | null;
  kind?: string | null;
  status?: 'queued' | 'running' | 'done' | 'failed' | 'dead' | null;
  priority?: number | null;
  attempts?: number | null;
  claimed_by?: string | null;
  created_at?: string | null;
}

export interface JobPage {
  items?: JobView[] | null;
}

export interface CreateJobInput {
  lane: JobLane;
  priority: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface AdapterView {
  id?: string | null;
  label?: string | null;
  state?: CapabilityState | null;
  capabilities?: string[] | null;
  protocol_version?: string | null;
  last_seen_at?: string | null;
  detail?: string | null;
}

export interface AdapterPage {
  items?: AdapterView[] | null;
}

export interface AuditEvent {
  event_id?: string | null;
  at?: string | null;
  tenant_id?: string | null;
  actor_alias?: string | null;
  action?: string | null;
  decision?: 'allow' | 'deny' | null;
  request_id?: string | null;
  trace_id?: string | null;
  summary?: string | null;
}

export interface AuditPage {
  items?: AuditEvent[] | null;
}

export type OriginRelayState = 'pending' | 'processing' | 'sent' | 'failed';

export interface OriginRelayView {
  id?: string | null;
  tenant_id?: string | null;
  adapter?: string | null;
  request_id?: string | null;
  message_id?: string | null;
  delivery_id?: string | null;
  trace_id?: string | null;
  status?: OriginRelayState | null;
  attempts?: number | null;
  created_at?: string | null;
  sent_at?: string | null;
}

export interface OriginRelayPage {
  items?: OriginRelayView[] | null;
}

export interface TerminalCapability {
  available: boolean;
  plugin_id?: string | null;
  capabilities?: string[] | null;
  websocket_path?: string | null;
  target_label?: string | null;
  reason?: string | null;
}

export type ConfigResource = 'tenant' | 'room' | 'membership' | 'acl_edge' | 'harness' | 'role_policy';
export type ConfigAction = 'create' | 'update' | 'delete';
export type ConfigMutation = Record<string, unknown> & {
  resource: ConfigResource;
  action: ConfigAction;
};

export interface ConfigRevision {
  id?: string | null;
  actor_tenant?: string | null;
  actor_alias?: string | null;
  operation?: ConfigMutation | null;
  summary?: string | null;
  rolled_back_revision_id?: string | null;
  created_at?: string | null;
}

export interface ConfigurationSnapshot {
  revision?: number | null;
  observed_at?: string | null;
  tenants?: Array<Record<string, unknown>> | null;
  rooms?: Array<Record<string, unknown>> | null;
  memberships?: Array<Record<string, unknown>> | null;
  acl_edges?: Array<Record<string, unknown>> | null;
  harness_definitions?: Array<Record<string, unknown>> | null;
  role_policies?: Array<Record<string, unknown>> | null;
  revisions?: ConfigRevision[] | null;
}

export interface ConfigurationChangeResult {
  applied?: boolean | null;
  dry_run?: boolean | null;
  revision?: number | null;
  summary?: string | null;
  mutation?: ConfigMutation | null;
  inverse_mutation?: ConfigMutation | null;
}

export interface ObservabilitySnapshot {
  observed_at?: string | null;
  status?: Record<string, unknown> | null;
  queues?: QueueSnapshot | null;
  jobs?: JobPage | null;
  origin_relays?: OriginRelayPage | null;
}
