/* eslint @typescript-eslint/consistent-type-definitions: "off" -- an interface has no implicit index signature and would stop being assignable to the `Record<string, unknown>` the repository contract returns. */
/**
 * Row shapes the console visibility filters consume. `listMessages` and `getMessage` project the
 * same delivery join under two different column vocabularies and the gateway filter cannot guess
 * which one it holds, so each shape is named here and used as the query generic that produces it.
 */

export type MessageListDeliveryRow = {
  delivery_id: string;
  recipient_tenant: string;
  recipient_alias: string;
  status: string;
  attempt: number;
  timeline: unknown[];
};

export type MessageListRow = {
  message_id: string;
  request_id: string | null;
  trace_id: string | null;
  tenant_id: string;
  room_id: string;
  actor_alias: string;
  body_preview: string | null;
  lane: string;
  created_at: Date;
  deliveries: MessageListDeliveryRow[];
};

export type MessageDetailDeliveryRow = {
  delivery_id: string;
  tenant_id: string;
  alias: string;
  status: string;
  attempt: number;
  terminal_at: string | null;
};

export type MessageDetailRow = {
  id: string;
  version: number;
  request_id: string | null;
  trace_id: string | null;
  tenant_id: string;
  room_id: string;
  actor_alias: string;
  body: unknown;
  origin: unknown;
  lane: string;
  priority: number;
  created_at: Date;
  deliveries: MessageDetailDeliveryRow[];
};

/**
 * One sampled delivery of `queueSnapshot`: `tenant_id` is the RECIPIENT tenant and
 * `message_tenant_id` the sender's, the reverse of the message rows above.
 */
export type QueueSnapshotItem = {
  delivery_id: string;
  message_id: string;
  tenant_id: string;
  recipient_alias: string;
  message_tenant_id: string;
  actor_alias: string;
  lane: string;
  state: string;
  attempts: number;
  max_attempts: number;
  available_at: Date | null;
  last_error: string | null;
};
