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
 * Una garra viva de la sesión. Además del par (attempt, claim_token) que ya fenceaba los ACKs,
 * conserva la correlación exacta del ACK y hasta cuándo sigue viva. La capacidad ya no se decide
 * en RAM: PostgreSQL la comparte durablemente entre HTTP, WebSocket, reconexiones y gateways.
 */
export interface SessionClaim {
  readonly attempt: GatewayAck['attempt'];
  readonly claim_token: GatewayAck['claim_token'];
  /**
   * Instante en que la garra deja de ocupar cupo. Arranca en el `ack_deadline_at` que puso la
   * base y se corre con cada ACK 'started' aplicado, que es exactamente lo que hace el store.
   */
  admissionExpiresAtMs: number;
  /**
   * La garra se reconstruyó desde la base al conectar, no la entregó esta sesión.
   *
   * Cambia UNA cosa y es importante: no se usa para fencear ACKs. Una garra rehidratada puede
   * ser de otra época o de otro intento —justamente lo que hace falta contar para el cupo— y si
   * se la tratara como expectativa de ACK, un ACK viejo del adaptador dejaría de correlacionar
   * y se llevaría un 'fenced' con cierre de socket, donde hoy recibe `ownership_lost` y sigue
   * vivo. Para eso la base ya es la autoridad.
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
  /** Un wake que llegó mientras drenábamos. Se atiende al terminar, nunca se pierde. */
  drainAgain: boolean;
  /** Promesa compartida por todos los wakes que se pliegan sobre el mismo drenaje. */
  drainPromise: Promise<boolean> | undefined;
  renewableDeliveryClaims: boolean;
  /**
   * El adaptador declaró entender la disciplina de delegación, así que `ack_result` puede llevar
   * `delegation_rejections` y `chain_gate`. Sin la capability esos campos NO se emiten: el
   * adaptador viejo valida el frame con `.strict()` y, cuando el esquema lo rechaza, no descarta
   * el frame — falla la cola entera de la conexión y se lleva puesto todo lo que tenía en vuelo.
   */
  delegationFeedback: boolean;
  claims: Map<string, SessionClaim>;
  recentClaims: Map<string, SessionClaim>;
  /** Re-drenaje programado al primer vencimiento de garra. Ver `scheduleExpiryDrain`. */
  expiryTimer: NodeJS.Timeout | undefined;
}
