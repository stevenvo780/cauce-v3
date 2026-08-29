import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Tenant } from '@cauce/protocol';
import type {
  AgentProfileRepository, DatabasePool, DeliveryLeaseCap, subscribeDeliveryWakes
} from '@cauce/store';
import type { AuthProvider } from '../../auth.js';
import type { ConsolePublishTelemetry } from '../../console-publish-telemetry.js';
import type { DeliveryAdmissionConfig } from '../../config.js';
import type { GatewayAck } from '../../app.js';
import type { WakePumpTelemetry } from '../../wake-pump-telemetry.js';

export type CorePublishHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

export interface CoreRouteOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly deliveryWakeSubscriber?: typeof subscribeDeliveryWakes;
}

export interface CoreResolvedOptions {
  readonly ackDeadlineMs: number;
  readonly deliveryLeaseCap: DeliveryLeaseCap;
  readonly admission: DeliveryAdmissionConfig;
  readonly maxQueryLimit: number;
  readonly leaseTtlMs: number;
  readonly outboxPollMs: number;
  readonly outboxLeaseMs: number;
  readonly outboxWakeConcurrency: number;
  readonly outboxShutdownTimeoutMs: number;
  readonly wakePumpTelemetry: WakePumpTelemetry;
  readonly consolePublishTelemetry: ConsolePublishTelemetry;
  readonly deliveryClaimLimit: number;
  readonly workerId: string;
}

export interface CoreRoutePhases {
  registerPublishRoutes(): CorePublishHandler;
  registerRuntimeRoutes(agentProfiles: AgentProfileRepository): Promise<void>;
}
/**
 * A live claim of the session. In addition to the (attempt, claim_token) pair that already fenced
 * ACKs, it preserves the exact ACK correlation and how long it stays alive. Capacity is no longer
 * decided in RAM: PostgreSQL shares it durably across HTTP, WebSocket, reconnections and gateways.
 */
export interface SessionClaim {
  readonly attempt: GatewayAck['attempt'];
  readonly claim_token: GatewayAck['claim_token'];
  /**
   * Moment when the claim stops occupying a slot. It starts at the `ack_deadline_at` set by the
   * database and moves forward with each applied 'started' ACK, which is exactly what the store does.
   */
  admissionExpiresAtMs: number;
/**
   * The claim was rebuilt from the database on connect, not delivered by this session.
   *
   * It changes ONE thing and it's important: it is not used to fence ACKs. A rehydrated claim
   * can be from another epoch or another attempt —exactly what needs to be counted for the
   * slot— and if treated as an ACK expectation, an old ACK from the adapter would stop
   * correlating and would take a 'fenced' with socket close, where today it receives
   * `ownership_lost` and stays alive. For that the database is already the authority.
   */
  readonly rehydrated?: true;
}

export interface Session {
  socket: WebSocket;
  tenantId: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
  /** Rotated by PostgreSQL on every hello, including a same-instance/same-epoch resume. */
  connectionToken: string;
  abort: AbortController;
  /** A wake that arrived while we were draining. It is served at the end, never lost. */
  drainAgain: boolean;
  /** Promise shared by all wakes that fold onto the same drain. */
  drainPromise: Promise<boolean> | undefined;
  renewableDeliveryClaims: boolean;
  /**
   * The adapter declared understanding the delegation discipline, so `ack_result` may carry
   * `delegation_rejections` and `chain_gate`. Without the capability those fields are NOT emitted:
   * the old adapter validates the frame with `.strict()` and, when the schema rejects it, doesn't
   * discard the frame — it fails the entire connection queue and takes everything it had in flight.
   */
  delegationFeedback: boolean;
  claims: Map<string, SessionClaim>;
  recentClaims: Map<string, SessionClaim>;
  /** Re-drain scheduled at the first claim expiration. See `scheduleExpiryDrain`. */
  expiryTimer: NodeJS.Timeout | undefined;
}
