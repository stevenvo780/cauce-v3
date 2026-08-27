/** Campos comunes de un acuse de recibo de outbox durable. */
export interface OutboxAck {
  readonly event_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly status: 'sent' | 'retry' | 'dead';
  readonly error?: string;
  readonly retry_after_ms?: number;
}

/** Un ACK de wake queda cercado por la sesión que lo recibió. */
export type OutboxAckWithConnection<TConnection> = OutboxAck & {
  readonly connection: TConnection;
};

/** Los egresses que producen efectos durables informan cuántos confirmaron. */
export type OutboxAckWithEffectCount = OutboxAck & {
  readonly effect_count?: number;
};
