import { WebSocket, type RawData } from 'ws';
import { ClaimedAckSchema, type Tenant } from '@cauce/protocol';
import { StoreError, type ConnectionSessionFence } from '@cauce/store';
import type { DeliveryClaimRecord, GatewayAck } from '../../app.js';
import { CONNECTION_TOKEN_PATTERN } from '../shared.js';
import type { Session, SessionClaim } from './contracts.js';

const MAX_RECENT_SESSION_CLAIMS = 1_024;
/**
 * Techo de garras que se rehidratan al conectar. Muy por encima de cualquier cupo razonable:
 * sólo está para que una cola patológica no se traiga miles de filas al socket. Si el alias
 * tuviera más garras vivas que esto, el presupuesto ya da cero de todas formas.
 */
export const MAX_REHYDRATED_CLAIMS = 256;
export const MAX_DRAIN_ROUNDS = 16;
// Estados de ACK que devuelven la entrega al mundo terminal o reintentable y por lo tanto la sacan
// de agents.max_concurrent_deliveries. Es el conjunto complementario de ('leased','accepted',
// 'started'), que es exactamente lo que cuenta claimDeliveries.
export const RELEASES_CAPACITY: ReadonlySet<string> = new Set(['done', 'failed', 'dead', 'retry']);

export function sessionKey(tenantId: Tenant, alias: string): string {
  return `${tenantId}:${alias}`;
}

export function connectionToken(value: unknown): string {
  if (typeof value !== 'string' || !CONNECTION_TOKEN_PATTERN.test(value)) {
    throw new StoreError('fenced', 'connection token is required');
  }
  return value;
}

export function parseConnectionBoundBody<T extends Record<string, unknown>>(
  body: unknown,
  parse: (value: unknown) => T,
): T & { connection_token: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new StoreError('invalid_input', 'connection-bound request must be an object');
  }
  const { connection_token: rawToken, ...withoutToken } = body as Record<string, unknown>;
  return { ...parse(withoutToken), connection_token: connectionToken(rawToken) };
}

export function sessionFence(session: Session): ConnectionSessionFence {
  return {
    tenant_id: session.tenantId,
    alias: session.alias,
    instance_id: session.instanceId,
    epoch: session.epoch,
    connection_token: session.connectionToken,
  };
}

export function send(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export function rawDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export function claimFromDelivery(delivery: DeliveryClaimRecord, fallbackDeadlineMs: number): SessionClaim {
  if (typeof delivery.event_id !== 'string' || delivery.event_id.length === 0 ||
      typeof delivery.claim_token !== 'string' || delivery.claim_token.length === 0 ||
      !Number.isInteger(delivery.attempt) || delivery.attempt < 1) {
    throw new Error('repository returned an incomplete delivery claim');
  }
  // `ack_deadline_at` lo generó PostgreSQL; es la única fuente de verdad sobre cuándo el reaper
  // puede llevarse la garra. Si viniera ilegible se usa el plazo configurado, que es lo mismo
  // que acaba de aplicar el store.
  const deadlineMs = Date.parse(delivery.ack_deadline_at);
  return {
    attempt: delivery.attempt,
    claim_token: delivery.claim_token,
    admissionExpiresAtMs: Number.isFinite(deadlineMs) ? deadlineMs : Date.now() + fallbackDeadlineMs
  };
}

export function normalizeDeliveryClaim(delivery: DeliveryClaimRecord, fallbackDeadlineMs: number): DeliveryClaimRecord {
  claimFromDelivery(delivery, fallbackDeadlineMs);
  return delivery;
}

export function parseAck(value: unknown): GatewayAck {
  return ClaimedAckSchema.parse(value);
}

export function assertAckClaim(ack: GatewayAck, expected?: Pick<SessionClaim, 'attempt' | 'claim_token'>): void {
  if (expected && (ack.attempt !== expected.attempt || ack.claim_token !== expected.claim_token)) {
    throw new StoreError('fenced', 'ACK claim does not match the delivered event');
  }
}

export function rememberRecentClaim(session: Session, deliveryId: string, claim: SessionClaim): void {
  session.recentClaims.delete(deliveryId);
  session.recentClaims.set(deliveryId, claim);
  while (session.recentClaims.size > MAX_RECENT_SESSION_CLAIMS) {
    const oldest = session.recentClaims.keys().next().value;
    if (oldest === undefined) break;
    session.recentClaims.delete(oldest);
  }
}

/**
 * Saca de RAM las garras cuyo plazo ya venció.
 *
 * De paso saca de `claims` las garras cuyo plazo ya venció. No es una optimización: una garra
 * vencida no se puede renovar nunca más (`ackDelivery` exige `ack_deadline_at > now()`, misma
 * condición), así que si se quedara en el mapa ocuparía un cupo para siempre y el agente se
 * quedaría sin trabajo hasta reconectar. Se mueve a `recentClaims` en vez de borrarse, porque
 * borrarla haría que un ACK tardío no correlacione y un cliente legacy se comiera un 'fenced'
 * con cierre de socket, cuando hoy recibe un `ownership_lost` y sigue vivo.
 *
 * El presupuesto no se calcula aquí: la base lo descuenta bajo el lock durable por alias. Este
 * mapa sólo conserva correlación de ACK y programa el próximo drenaje por expiración.
 */
export function pruneExpiredClaims(session: Session, nowMs: number): void {
  for (const [deliveryId, claim] of [...session.claims]) {
    if (claim.admissionExpiresAtMs <= nowMs) {
      session.claims.delete(deliveryId);
      rememberRecentClaim(session, deliveryId, claim);
    }
  }
}
