import type { ChildProcess } from 'node:child_process';

interface DiagnosticPool {
  query(config: { text: string; values: unknown[]; query_timeout: number }): Promise<{ rows: Record<string, unknown>[] }>;
}
interface Input {
  pool: DiagnosticPool;
  tenant: { tenant: string; target: string; room: string };
  instanceId: string;
  selector: { kind: 'text' | 'filename'; value: string };
  stdout: string;
  stderr: string;
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'killed'> | undefined;
  gateway?: ChatLatencyCapture;
}
const MESSAGE = `m.tenant_id=$1 AND d.recipient_tenant=$1 AND d.recipient_alias=$2
  AND (CASE WHEN $3='text' THEN m.body->>'text' ELSE m.body->'attachments_v1'->0->>'name' END)=$4`;
const QUERIES = {
  deliveries: `SELECT m.id AS message_id,d.id AS delivery_id,d.status,d.attempt,
    d.available_at,d.available_at<=clock_timestamp() AS available_now,
    d.last_ack_rank,d.terminal_at,d.last_error IS NOT NULL AS has_error,
    d.consumer_epoch,d.consumer_instance_id=$5 AS expected_consumer,
    d.ack_deadline_at,d.ack_deadline_at>clock_timestamp() AS claim_live,
    EXISTS(SELECT 1 FROM delivery_acks a WHERE a.delivery_id=d.id AND a.applied AND a.status='done') AS applied_done,
    EXISTS(SELECT 1 FROM dead_letters l WHERE l.delivery_id=d.id) AS dead_letter
    FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE ${MESSAGE} ORDER BY d.id LIMIT 8`,
  wakes: `SELECT o.id AS event_id,o.status,o.attempts,o.available_at,o.claim_expires_at,
    o.last_error IS NOT NULL AS has_error FROM adapter_outbox o
    JOIN messages m ON m.id=o.message_id JOIN deliveries d ON d.id=o.delivery_id
    WHERE ${MESSAGE} AND o.tenant_id=$1 AND o.kind='wake' ORDER BY o.id LIMIT 8`,
  consumer: `SELECT a.enabled AS agent_enabled,a.max_concurrent_deliveries,
    l.instance_id=$3 AS expected_instance,l.epoch,l.lease_until,l.last_heartbeat_at,
    l.lease_until>clock_timestamp() AS lease_live,
    EXISTS(SELECT 1 FROM memberships b WHERE b.tenant_id=$1 AND b.room_id=$4 AND b.alias=$2
      AND b.enabled AND b.role='agent') AS agent_membership,
    (SELECT count(*) FROM deliveries d WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
      AND d.status IN ('leased','accepted','started') AND d.ack_deadline_at>clock_timestamp()) AS in_flight
    FROM agents a LEFT JOIN connection_leases l ON l.tenant_id=a.tenant_id AND l.alias=a.alias
    WHERE a.tenant_id=$1 AND a.alias=$2`,
  holds: `SELECT id,expires_at,expires_at>clock_timestamp() AS hold_live FROM terminal_control_holds
    WHERE tenant_id=$1 AND alias=$2 AND released_at IS NULL ORDER BY id LIMIT 8`,
  context: `SELECT id,status,payload->>'dispatch'='authorized' AS authorized,
    payload->'completion' IS NOT NULL AND payload->'completion'<>'null'::jsonb AS completed
    FROM jobs WHERE tenant_id=$1 AND kind='system.context.write.quarantine.v1'
      AND payload->>'alias'=$2 ORDER BY id LIMIT 8`,
  contextLocks: `WITH key AS (SELECT hashtextextended($1,0) AS value)
    SELECT l.pid,l.granted,l.mode FROM pg_locks l,key
    WHERE l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND l.locktype='advisory' AND l.classid::bigint=((key.value >> 32) & 4294967295)
      AND l.objid::bigint=(key.value & 4294967295) AND l.objsubid=1 ORDER BY l.pid LIMIT 8`,
};
const STATUSES = new Set(['pending', 'retry', 'leased', 'accepted', 'started', 'done', 'failed', 'dead', 'processing', 'sent', 'running']);
const EVENTS = new Set(['profile_seed', 'shared_session_degraded', 'shared_session_resume', 'harness_start_witness_disabled',
  'spawn', 'exit', 'terminate', 'fixed_context', 'emission_result', 'claim_renewal_start', 'claim_renewal_end', 'internal_error',
  'connection_error', 'connection_degraded', 'delivery_start', 'delivery_state', 'delivery_end',
  'inbound_frame_invalid', 'outbound_frame_invalid']);
const SDK_CODES = new Set([
  'HELLO_ACK_TIMEOUT', 'HEARTBEAT_ACK_TIMEOUT', 'CONNECTION_LEASE_EXPIRED', 'INVALID_LEASE_EXPIRY',
  'CONNECT_TIMEOUT', 'CONNECTION_SEND_TIMEOUT', 'CONNECTION_SEND_FAILED', 'CONNECTION_GENERATION_STALE',
  'CONNECTION_CLOSED', 'FRAME_BEFORE_HELLO', 'DUPLICATE_HELLO', 'CONNECT_FAILED', 'EPHEMERAL_CONNECTION',
  'TAKEOVER_REJECTED', 'PROFILE_SEED_FAILED', 'OUTBOX_ENTRY_QUARANTINED',
  'EXECUTION_INTENT_CONFIRMATION_FAILED', 'EXECUTION_INTENT_PERSISTENCE_FAILED',
  'FENCED', 'CLAIM_OWNERSHIP_LOST', 'SESSION_QUEUE_ABORTED', 'SESSION_QUEUE_TIMEOUT',
  'CANCELLED', 'SHUTDOWN', 'HARNESS_EMPTY_RESULT', 'HARNESS_REPORTED_FAILURE', 'UNSUPPORTED_HUMAN_EMISSION_SCOPE',
  'MALFORMED_OUTPUT', 'STALE_EPOCH', 'CONSUMER_LEASE', 'INTERNAL',
  'EMISSION_ENDPOINT_OVERRIDE', 'INVALID_COMMAND', 'INVALID_EMISSION_ENDPOINT', 'INVALID_TIMEOUT',
  'OUTPUT_LIMIT_AMBIGUOUS', 'PROMPT_IN_ARGV', 'SECRET_ENV_REJECTED', 'SPAWN_FAILED',
  'INBOUND_FRAME_SCHEMA', 'INBOUND_FRAME_DECODE', 'OUTBOUND_FRAME_SCHEMA', 'OUTBOUND_FRAME_ENCODE',
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'ACK_DEADLINE_BUDGET_EXHAUSTED', 'ACK_DEADLINE_INVALID', 'ALL_TARGET_MUST_BE_EXCLUSIVE',
  'AMBIGUOUS_DELEGATION_TARGET', 'CLAIM_RENEWAL_PERSISTENCE_FAILED', 'CLAIM_RENEWAL_UNCONFIRMED',
  'DELEGATION_TO_SELF', 'EXECUTION_FAILED', 'EXPANDED_RELAY_AGGREGATE_TOO_LARGE',
  'FANIN_HARNESS_EXECUTION_FORBIDDEN', 'FANIN_REDELEGATION_FORBIDDEN', 'INTERNAL_ALL_FORBIDDEN',
  'INTERRUPTED_AMBIGUOUS', 'INTERRUPTED_PREFLIGHT', 'INVALID_ATTACHMENT',
  'INVALID_DELIVERY', 'INVISIBLE_REPLY', 'MUSE_APPROVAL_FAILED',
  'MUSE_APPROVAL_UNVERIFIED', 'MUSE_CATALOG_INVALID', 'MUSE_EFFORT_UNVERIFIED',
  'MUSE_EVENT_BUFFER_LIMIT', 'MUSE_EXECUTION_AMBIGUOUS', 'MUSE_FINAL_UNVERIFIED',
  'MUSE_FOREIGN_VIEW', 'MUSE_GAP_FAILED', 'MUSE_HOST_EXITED',
  'MUSE_MCP_CAPABILITY_REQUIRED', 'MUSE_MCP_UNAVAILABLE', 'MUSE_MODEL_UNVERIFIED',
  'MUSE_NO_AUTO_UPDATE', 'MUSE_OUTPUT_TOO_LARGE', 'MUSE_OUTPUT_TRUNCATED',
  'MUSE_PREFLIGHT_FAILED', 'MUSE_PREFLIGHT_TIMEOUT', 'MUSE_PROGRESS_CURSOR_LIMIT',
  'MUSE_PROTOCOL_FAILED', 'MUSE_REASONING_UNSUPPORTED', 'MUSE_RECONCILIATION_FAILED',
  'MUSE_TERMINAL_UNVERIFIED', 'MUSE_TURN_ACK_INVALID', 'MUSE_TURN_AMBIGUOUS',
  'MUSE_TURN_IDLE_WITHOUT_TERMINAL', 'MUSE_TURN_UNQUEUED', 'MUSE_VIEW_HEALTH_UNKNOWN',
  'MUSE_VIEW_PAGE_STALLED', 'MUSE_VIEW_UNAVAILABLE', 'NATIVE_PROFILE_CONTEXT_PREFLIGHT_FAILED',
  'NO_ONLINE_TARGETS', 'OFFLINE_DELEGATION_TARGET', 'PROMPT_NOT_DISPATCHED',
  'ROUTING_INVENTORY_UNAVAILABLE', 'SHARED_TUI_UNAVAILABLE', 'STALE_ON_RECOVERY',
  'UNKNOWN_DELEGATION_TARGET', 'UNSUPPORTED_HUMAN_ISOLATION',
]);
const SDK_REASONS = new Set([...SDK_CODES, 'outbox_entry_quarantined', 'frame_dropped',
  'ownership_lost', 'queue_renewal_not_applied', 'confirmed', 'text_fallback', 'mcp_deposit']);
const PHASES = new Set(['accepted', 'started', 'done', 'failed']);
const BOOLEANS = new Set(['available_now', 'expected_consumer', 'claim_live', 'applied_done', 'dead_letter', 'has_error',
  'agent_enabled', 'expected_instance', 'lease_live', 'agent_membership', 'hold_live', 'authorized', 'completed', 'granted']);
const NUMBERS = new Set(['attempt', 'attempts', 'last_ack_rank', 'consumer_epoch', 'epoch', 'max_concurrent_deliveries', 'in_flight', 'pid']);
const TIMES = new Set(['available_at', 'terminal_at', 'ack_deadline_at', 'claim_expires_at', 'lease_until', 'last_heartbeat_at', 'expires_at']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const CHAT_PHASES = new Set(['publish_receipt_verified', 'publish_http_reply_completed',
  'drain_started', 'drain_joined', 'drain_finished', 'delivery_claim_entered',
  'delivery_claim_result', 'delivery_frame_queued', 'delivery_frame_not_queued']);
const CHAT_STATUSES = new Set(['empty', 'returned', 'queued', 'not_queued', 'fenced', 'cancelled', 'error']);

export class ChatLatencyCapture {
  private partial = '';
  private readonly events: Record<string, unknown>[] = [];
  private discarded = 0;

  write(chunk: string): void {
    if (chunk.length + this.partial.length > 32_768) { this.partial = ''; this.discarded += 1; return; }
    const lines = (this.partial + chunk).split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (row.event !== 'chat_latency' || row.version !== 1
          || typeof row.phase !== 'string' || !CHAT_PHASES.has(row.phase)) continue;
      const event: Record<string, unknown> = { event: 'chat_latency', version: 1, phase: row.phase };
      for (const key of ['message_id', 'delivery_id', 'request_id', 'operation_id']) {
        if (typeof row[key] === 'string' && UUID.test(row[key])) event[key] = row[key];
      }
      for (const key of ['at', 'wake_claim_started_at', 'wake_claim_finished_at']) {
        if (typeof row[key] === 'string' && TIMESTAMP.test(row[key]) && Number.isFinite(Date.parse(row[key]))) event[key] = row[key];
      }
      for (const key of ['elapsed_ms', 'wake_claim_elapsed_ms', 'round', 'attempt', 'claimed_count']) {
        const number = row[key];
        if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 86_400_000
            && (key.endsWith('_ms') || Number.isSafeInteger(number))
            && (key !== 'round' || number < 16) && (key !== 'attempt' || number >= 1)) event[key] = number;
      }
      if (typeof row.status === 'string' && CHAT_STATUSES.has(row.status)) event.status = row.status;
      this.events.push(event);
      if (this.events.length > 256) { this.events.shift(); this.discarded += 1; }
    }
  }

  forDeliveryRows(rows: readonly Record<string, unknown>[]): Record<string, unknown> {
    const messages = new Set(rows.map(row => row.message_id));
    const deliveries = new Set(rows.map(row => row.delivery_id));
    const matches = (event: Record<string, unknown>) => {
      const hasMessage = typeof event.message_id === 'string';
      const hasDelivery = typeof event.delivery_id === 'string';
      return (hasMessage || hasDelivery) && (!hasMessage || messages.has(event.message_id))
        && (!hasDelivery || deliveries.has(event.delivery_id));
    };
    const operations = new Set(this.events.filter(matches).map(event => event.operation_id)
      .filter((id): id is string => typeof id === 'string'));
    return { status: 'OBSERVED_PARTIAL_CAPTURE', discarded: this.discarded,
      events: this.events.filter(event => {
        if (typeof event.message_id === 'string' || typeof event.delivery_id === 'string') return matches(event);
        return typeof event.operation_id === 'string' && operations.has(event.operation_id);
      }) };
  }
}

function safeRow(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(row)) {
    const value = raw instanceof Date ? raw.toISOString() : raw;
    if (BOOLEANS.has(key) && (value === null || typeof value === 'boolean')) output[key] = value;
    if (NUMBERS.has(key) && (value === null || (typeof value === 'number' && Number.isSafeInteger(value))
      || (typeof value === 'string' && /^\d{1,20}$/u.test(value)))) output[key] = value;
    if (TIMES.has(key) && (value === null || (typeof value === 'string' && TIMESTAMP.test(value)))) output[key] = value;
    if (['id', 'message_id', 'delivery_id', 'event_id'].includes(key) && typeof value === 'string' && UUID.test(value)) output[key] = value;
    if (key === 'status' && typeof value === 'string' && STATUSES.has(value)) output[key] = value;
    if (key === 'mode' && ['ShareLock', 'ExclusiveLock'].includes(String(value))) output[key] = value;
  }
  return output;
}
function errorCode(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (/^[0-9]{2}[A-Z0-9]{3}$/u.test(code)
    || ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)) ? code : 'UNKNOWN';
}
function sdkEvents(raw: string, alias: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.slice(-64 * 1024).split('\n')) {
    if (line.length > 4096) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.event !== 'string' || !EVENTS.has(row.event)) continue;
    const event: Record<string, unknown> = { event: row.event };
    if (row.alias === alias) event.alias = alias;
    for (const key of ['ts', 'timestamp']) {
      if (typeof row[key] === 'string' && TIMESTAMP.test(row[key])) event[key] = row[key];
    }
    if (row.reason !== undefined) event.reason = typeof row.reason === 'string' && SDK_REASONS.has(row.reason) ? row.reason : 'UNKNOWN';
    if (typeof row.phase === 'string' && PHASES.has(row.phase)) event.phase = row.phase;
    for (const key of ['lease_until', 'lease_expires_at', 'last_heartbeat_at']) {
      if (typeof row[key] === 'string' && TIMESTAMP.test(row[key])) event[key] = row[key];
    }
    if (typeof row.delivery_id === 'string' && UUID.test(row.delivery_id)) event.delivery_id = row.delivery_id;
    if (typeof row.attempt === 'number' && Number.isSafeInteger(row.attempt) && row.attempt >= 0) event.attempt = row.attempt;
    if (row.error_code !== undefined) event.error_code = typeof row.error_code === 'string' && SDK_CODES.has(row.error_code) ? row.error_code : 'UNKNOWN';
    events.push(event);
  }
  return events.slice(-16);
}

export async function browserDeliveryFailure(cause: unknown, input: Input): Promise<Error> {
  const { tenant, target, room } = input.tenant;
  const values = [tenant, target, input.selector.kind, input.selector.value, input.instanceId];
  const sql: Record<string, unknown> = {};
  let deliveryRows: Record<string, unknown>[] = [];
  await Promise.all(Object.entries(QUERIES).map(async ([name, text]) => {
    const params = name === 'consumer' ? [tenant, target, input.instanceId, room]
      : name === 'contextLocks' ? [`agent-context-reconcile:${tenant}:${target}`]
      : ['holds', 'context'].includes(name) ? [tenant, target] : name === 'wakes' ? values.slice(0, 4) : values;
    try {
      const result = await input.pool.query({ text, values: params, query_timeout: 1500 });
      if (name === 'deliveries') deliveryRows = result.rows.slice(0, 8).map(safeRow);
      sql[name] = { status: 'OBSERVED', rows: result.rows.slice(0, 8).map(safeRow) };
    } catch (error) { sql[name] = { status: 'UNKNOWN', errorCode: errorCode(error) }; }
  }));
  const child = input.child;
  const diagnostic = {
    version: 1, eligibility: 'PARTIAL_OBSERVATIONS_NOT_ADMISSION_PROOF', sql,
    sdk: { stdout: sdkEvents(input.stdout, target), stderr: sdkEvents(input.stderr, target) },
    gateway: input.gateway?.forDeliveryRows(deliveryRows) ?? { status: 'UNKNOWN' },
    child: child === undefined ? { status: 'UNKNOWN' } : {
      pid: child.pid ?? null, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed,
      status: 'EXIT_FIELDS_ONLY_NOT_LIVENESS_PROOF',
    },
  };
  return new Error(`Browser delivery wait failed; diagnostic=${JSON.stringify(diagnostic)}`, { cause });
}
