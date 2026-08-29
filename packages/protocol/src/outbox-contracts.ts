/** Common fields of a durable outbox acknowledgment. */
export interface OutboxAck {
  readonly event_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly status: 'sent' | 'retry' | 'dead';
  readonly error?: string;
  readonly retry_after_ms?: number;
}

/** A wake ACK is fenced by the session that received it. */
export type OutboxAckWithConnection<TConnection> = OutboxAck & {
  readonly connection: TConnection;
};

/** Egresses that produce durable effects report how many confirmed. */
export type OutboxAckWithEffectCount = OutboxAck & {
  readonly effect_count?: number;
};
