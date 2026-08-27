import type { Ack, ChainGateNotice, DelegationMaterializationNotice, DelegationRejectionNotice, DeliveryEnvelope, DeliveryState, ProfileRuntimeAdoptionEvidence, ProfileRuntimeContract, Tenant } from '@cauce/protocol';
import {
  HUMAN_PRIORITY_FLOOR, isAmbiguousAckErrorCode, NOTIFY_KINDS, PROTOCOL_VERSION,
  ProfileRuntimeAdoptionEvidenceSchema
} from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { withAbortableTransaction, withTransaction } from '../db.js';
import { MessagesRepository, terminal } from './messages.js';
import { objectRecord, textualReply, validConnectionToken, visibleText } from './outbox.js';
import { deliveryLeaseCapMs, type AgentResponseDisposition, type ChainPolicy, type DeliveryLeaseCap, type DeliveryRow, type LateRelayDisposition } from './observability.js';
import { StoreError } from './quotas.js';

export interface LeaseResult {
  acquired: boolean;
  epoch?: number;
  /** Opaque per-hello fence. Present on every successful acquisition/resume. */
  connection_token?: string;
  lease_expires_at: string;
  active_instance_id?: string;
}


/**
 * Control de admisión para `claimDeliveries`.
 * Acota el volumen de entregas en vuelo según capacidad general y reservas humanas.
 */
export interface DeliveryAdmission {
  /**
   * Capacidad general DURABLE del consumidor, compartida por HTTP, WebSocket, reconexiones e
   * instancias de gateway. Si se omite, manda `agents.max_concurrent_deliveries`.
   */
  readonly generalCapacity?: number;
  /**
   * Capacidad ADICIONAL durable que sólo puede ocupar prioridad autenticada de persona. No es un
   * cupo nuevo por llamada: se descuentan todas las garras vivas del alias bajo el mismo lock.
   */
  readonly humanReservedCapacity?: number;
  /** Techo TOTAL de filas devueltas por esta llamada; `limit + reserva` si se omite. */
  readonly maxClaims?: number;
  /** Runtime gate: reject aliases absent from the durable agent inventory. */
  readonly requireDeclaredCapacity?: boolean;
  /**
   * Cuántos reclamos humanos seguidos antes de dejar pasar un trabajo no humano. Evita que una
   * ráfaga de mensajes humanos mate de hambre al trabajo de máquina. Por defecto toma el
   * mismo valor que `interactiveBurst` (3), que es el que ya usaba la alternancia de carriles.
   */
  readonly humanBurst?: number;
}


/** Garra viva de un alias para reconstruir presupuesto de admisión en reconexión. */
export interface LiveDeliveryClaim {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly ack_deadline_at: string;
  /** Hecho derivado de prioridad trusted-at-ingress, nunca del body controlado por el productor. */
  readonly human_originated: boolean;
}


/**
 * Un rechazo de delegación tal como lo lee el agente que lo provocó: código estable + motivo y
 * qué hacer en vez de reintentar. Viaja en la respuesta del ACK, así que hacer legible el
 * rechazo NO cuesta ni una entrega nueva.
 */
/**
 * ES el tipo del esquema del frame, no una copia con la misma forma. Mientras fueron dos
 * declaraciones paralelas se pudo agregar el campo al store sin agregarlo al esquema del frame, y
 * eso es lo que llegó a producción. Ahora el store no puede describir un rechazo que el adaptador
 * no sepa validar: no compilaría.
 */
export type DelegationRejection = DelegationRejectionNotice;
export type DelegationMaterialization = DelegationMaterializationNotice;
interface LateResultRow {
  late_result_at: Date | null;
  /** Momento de cancelación manual por operador; previene rescate tardío si está presente. */
  cancelled_at: Date | null;
}
type LateClaimProvenance = 'current' | 'applied' | 'observed' | 'none';
export interface AckResult {
  delivery_id: string;
  status: DeliveryState;
  applied: boolean;
  receipt: 'applied' | 'duplicate' | 'superseded' | 'ownership_lost';
  /** Presente sólo cuando alguna salida `messages` no se convirtió en entrega. */
  delegation_rejections?: DelegationRejection[];
  /** Salidas materializadas con la identidad exacta de la entrega hija; nunca incluye bodies. */
  delegation_materializations?: DelegationMaterialization[];
  /**
   * La rama quedó suspendida esperando a una persona; hay un gate abierto que la reanudará.
   *
   * El tipo sale del esquema del frame a propósito: los dos campos que siguen VIAJAN al adaptador
   * dentro de `ack_result`, así que cambiarles la forma acá sin cambiar el esquema allá tiene que
   * romper el build. Eso es precisamente lo que no pasó cuando se agregaron.
   */
  chain_gate?: ChainGateNotice;
}
export interface AgentOutputOutcome {
  materialized: number;
  /**
   * La rama abrió un gate humano: NO debe devolver su respuesta hacia arriba, porque no terminó
   * — está esperando. Es la diferencia entre "suspendida" y "fallada", y es lo que evita que un
   * gate se convierta en una entrega muerta.
   */
  suspended: boolean;
  rejections: DelegationRejection[];
  materializations: DelegationMaterialization[];
  /** El gate vigente de la raíz, si esta materialización se topó con uno o abrió uno. */
  gate?: OpenChainGate;
}
export interface OpenChainGate {
  id: string;
  question: string;
}
export interface ClaimedDeliveryEnvelope extends DeliveryEnvelope {
  event_id: string;
}
export interface LeaseAcquireOptions {
  /** Explicitly fence a still-live consumer. Omit for the default no-takeover behavior. */
  takeover?: boolean;
  /** Resume the same stable instance/epoch after a transport interruption. */
  resume?: boolean;
  /** Maximum age of the previous lease for a same-instance resume. */
  resumeWindowMs?: number;
  /** Refuse the lease atomically unless the consumer has a valid durable capacity row. */
  requireDeclaredCapacity?: boolean;
}
function ackRank(status: Ack['status']): number {
  if (status === 'accepted') return 1;
  if (status === 'started') return 2;
  return 3;
}
export const maxAgentOutputMessages = 100;
const maxAgentOutputBodyBytes = 64 * 1024;
const maxAgentOutputAggregateBytes = 256 * 1024;
const maxNotifyDirectives = 4;
export const maxNotifyBodyBytes = 4 * 1024;
const maxNotifyAggregateBytes = 8 * 1024;
export const notifyKinds = new Set<string>(NOTIFY_KINDS);
export const handlePattern = /^[a-z][a-z0-9_.-]{0,63}$/u;
export interface AgentOutputEntry {
  index: number;
  target: unknown;
  body: unknown;
  rejection?: 'invalid_output';
}
export interface RoutingTarget {
  tenant_id: Tenant;
  alias: string;
  online: boolean;
}
export type NotifyDenialCode =
  | 'notify_permission_denied'
  | 'unknown_destination'
  | 'destination_disabled'
  | 'kind_not_allowed'
  | 'cold_contact'
  | 'rate_limited'
  | 'root_quota_exhausted'
  | 'quiet_hours'
  | 'invalid_output'
  | 'body_too_large'
  | 'ambiguous_execution';
export interface AgentNotifyEntry {
  index: number;
  handle: string;
  kind: string;
  body: string;
  forcedDenial?: NotifyDenialCode;
}
const nulCharacter = String.fromCharCode(0);
function postgresJsonSafe(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(nulCharacter, '');
  if (Array.isArray(value)) return value.map(postgresJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, postgresJsonSafe(child)])
    );
  }
  return value;
}
export function postgresTextSafe(value: string | undefined): string | undefined {
  return value?.replaceAll(nulCharacter, '');
}
function profileRuntimeAdoptionEvidence(
  result: Record<string, unknown> | undefined,
): ProfileRuntimeAdoptionEvidence | undefined {
  const parsed = ProfileRuntimeAdoptionEvidenceSchema.safeParse(result?.profile_adoption);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    documents: [...parsed.data.documents].sort((left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path)),
  };
}
function agentOutputEntries(result: Record<string, unknown> | undefined): AgentOutputEntry[] {
  const output = objectRecord(result?.output);
  if (!output || output.messages === undefined) return [];
  if (!Array.isArray(output.messages)) {
    return [{ index: 0, target: undefined, body: undefined, rejection: 'invalid_output' }];
  }
  if (output.messages.length > maxAgentOutputMessages) {
    return [{ index: 0, target: undefined, body: undefined, rejection: 'invalid_output' }];
  }
  const entries = output.messages.map((value, index) => {
    const entry = objectRecord(value);
    if (!entry || typeof entry.to !== 'string'
      || typeof entry.body !== 'string' || !visibleText(entry.body)
      || Buffer.byteLength(entry.body, 'utf8') > maxAgentOutputBodyBytes) {
      return {
        index,
        target: entry?.to,
        body: entry?.body,
        rejection: 'invalid_output' as const
      };
    }
    return { index, target: entry.to, body: entry.body };
  });
  const aggregateBytes = entries.reduce(
    (total, entry) => total + (typeof entry.body === 'string'
      ? Buffer.byteLength(entry.body, 'utf8')
      : 0),
    0
  );
  return aggregateBytes > maxAgentOutputAggregateBytes
    ? entries.map((entry) => ({ ...entry, rejection: 'invalid_output' as const }))
    : entries;
}
function boundedHandle(value: unknown): string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 ? value : 'invalid';
}
function agentNotifyEntries(result: Record<string, unknown> | undefined): AgentNotifyEntry[] {
  const output = objectRecord(result?.output);
  if (!output || output.notify === undefined) return [];
  const invalid = (index: number, handle: unknown, kind: unknown): AgentNotifyEntry => ({
    index,
    handle: boundedHandle(handle),
    kind: typeof kind === 'string' && notifyKinds.has(kind) ? kind : 'alert',
    body: '',
    forcedDenial: 'invalid_output'
  });
  if (!Array.isArray(output.notify)) return [invalid(0, undefined, undefined)];
  // One bounded denial row records the whole over-limit batch; fanning it out
  // would let a malformed output write as many rows as it asked for.
  if (output.notify.length > maxNotifyDirectives) return [invalid(0, undefined, undefined)];
  const entries = output.notify.map((value, index): AgentNotifyEntry => {
    const entry = objectRecord(value);
    if (!entry || typeof entry.to !== 'string' || !handlePattern.test(entry.to)
      || typeof entry.kind !== 'string' || !notifyKinds.has(entry.kind)
      || typeof entry.body !== 'string' || !visibleText(entry.body)) {
      return invalid(index, entry?.to, entry?.kind);
    }
    if (Buffer.byteLength(entry.body, 'utf8') > maxNotifyBodyBytes) {
      return { index, handle: entry.to, kind: entry.kind, body: '', forcedDenial: 'body_too_large' };
    }
    return { index, handle: entry.to, kind: entry.kind, body: entry.body };
  });
  const aggregateBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.body, 'utf8'),
    0
  );
  return aggregateBytes > maxNotifyAggregateBytes
    ? entries.map((entry) => ({ ...entry, body: '', forcedDenial: 'body_too_large' as const }))
    : entries;
}
function sanitizedAckResult(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return result;
  const withoutProfileAdoption = { ...result };
  delete withoutProfileAdoption.profile_adoption;
  const normalized = Object.keys(withoutProfileAdoption).length === 0
    ? undefined
    : withoutProfileAdoption;
  const output = objectRecord(normalized?.output);
  if (!normalized || !output) return normalized;
  const hasMessages = Object.prototype.hasOwnProperty.call(output, 'messages');
  const hasNotify = Object.prototype.hasOwnProperty.call(output, 'notify');
  if (!hasMessages && !hasNotify) return normalized;
  // Absence is preserved on purpose: injecting a key an output never had would
  // change the bytes persisted in delivery_acks.payload and in the relay payload.
  return {
    ...normalized,
    output: {
      ...output,
      ...(hasMessages ? { messages: [] } : {}),
      ...(hasNotify ? { notify: [] } : {})
    }
  };
}
export abstract class DeliveriesRepository extends MessagesRepository {
protected abstract profileRuntimeExpectation(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<ProfileRuntimeContract | undefined>;
protected abstract recordProfileRuntimeAdoption(client: DatabaseClient, tenantId: Tenant, alias: string, row: DeliveryRow, ack: Ack, evidence: ProfileRuntimeAdoptionEvidence | undefined): Promise<boolean>;
protected abstract selfRoleFromProfile(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<string | undefined>;
protected abstract routingTargets(client: DatabaseClient, sourceTenant: Tenant, sourceAlias: string): Promise<RoutingTarget[]>;
protected abstract delegationFeedbackForAck(client: DatabaseClient, deliveryId: string, attempt: number): Promise<Pick<AckResult, 'delegation_rejections' | 'delegation_materializations'>>;
protected abstract materializeAgentOutputs(client: DatabaseClient, row: DeliveryRow, ack: Ack, outputs: AgentOutputEntry[], policy: ChainPolicy): Promise<AgentOutputOutcome>;
protected abstract insertAck(client: DatabaseClient, row: DeliveryRow, ack: Ack, applied: boolean, persistedResult: Record<string, unknown> | undefined, renewal?: boolean): Promise<void>;
protected abstract materializeAgentNotifications(client: DatabaseClient, row: DeliveryRow, ack: Ack, entries: AgentNotifyEntry[], ambiguousExecution: boolean): Promise<{ allowed: number; denied: number; errors: number }>;


  async acquireLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    capabilities: string[],
    ttlMs: number,
    options: LeaseAcquireOptions = {}
  ): Promise<LeaseResult> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new StoreError('conflict', 'lease TTL must be positive');
    const resumeWindowMs = options.resumeWindowMs ?? ttlMs;
    if (!Number.isSafeInteger(resumeWindowMs) || resumeWindowMs <= 0) {
      throw new StoreError('conflict', 'lease resume window must be a positive integer');
    }
    if (options.requireDeclaredCapacity !== undefined
        && typeof options.requireDeclaredCapacity !== 'boolean') {
      throw new StoreError('conflict', 'lease capacity requirement must be boolean');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      if (options.requireDeclaredCapacity === true) {
        const capacity = await client.query<{ cap: number | null }>(
          `SELECT max_concurrent_deliveries AS cap
             FROM agents WHERE tenant_id=$1 AND alias=$2 FOR SHARE`,
          [tenantId, alias],
        );
        const row = capacity.rows[0];
        if (row === undefined) {
          throw new StoreError('conflict', 'delivery consumer is missing its durable agent capacity');
        }
        if (row.cap !== null
            && (!Number.isSafeInteger(row.cap) || row.cap < 1 || row.cap > 100)) {
          throw new StoreError('conflict', 'delivery consumer capacity is invalid');
        }
      }
      // A missing row cannot be protected by SELECT ... FOR UPDATE. The keyed transaction
      // lock serializes the initial insert as well as all later takeovers.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `connection-lease:${tenantId}:${alias}`
      ]);
      const current = await client.query<{
        instance_id: string;
        epoch: string;
        lease_until: Date;
        live: boolean;
        resumable: boolean;
      }>(
        `SELECT instance_id,epoch,lease_until,(lease_until > now()) AS live,
                (instance_id=$3 AND lease_until > now()-$4*interval '1 millisecond') AS resumable
         FROM connection_leases WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
        [tenantId, alias, instanceId, resumeWindowMs]
      );
      const active = current.rows[0];
      if (options.resume === true && active?.resumable) {
        const resumed = await client.query<{ lease_until: Date; connection_token: string }>(
          `UPDATE connection_leases
           SET capabilities=$5::jsonb,lease_until=now()+$6*interval '1 millisecond',
               last_heartbeat_at=now(),connection_token=gen_random_uuid()
           WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
           RETURNING lease_until,connection_token::text`,
          [tenantId, alias, instanceId, Number(active.epoch), JSON.stringify(capabilities), ttlMs]
        );
        return {
          acquired: true,
          epoch: Number(active.epoch),
          connection_token: resumed.rows[0]!.connection_token,
          lease_expires_at: resumed.rows[0]!.lease_until.toISOString()
        };
      }
      if (active?.live && options.takeover !== true) {
        return {
          acquired: false,
          active_instance_id: active.instance_id,
          lease_expires_at: active.lease_until.toISOString()
        };
      }
      const nextEpoch = active ? Number(active.epoch) + 1 : 1;
      const lease = await client.query<{ lease_until: Date; connection_token: string }>(
        `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at)
         VALUES($1,$2,$3,$4,$5::jsonb,now()+$6*interval '1 millisecond',now(),now())
         ON CONFLICT(tenant_id,alias) DO UPDATE SET
           instance_id=EXCLUDED.instance_id,epoch=EXCLUDED.epoch,capabilities=EXCLUDED.capabilities,
           lease_until=EXCLUDED.lease_until,last_heartbeat_at=now(),connected_at=now(),
           connection_token=gen_random_uuid()
         RETURNING lease_until,connection_token::text`, [tenantId, alias, instanceId, nextEpoch, JSON.stringify(capabilities), ttlMs]
      );
      return {
        acquired: true,
        epoch: nextEpoch,
        connection_token: lease.rows[0]!.connection_token,
        lease_expires_at: lease.rows[0]!.lease_until.toISOString(),
      };
    });
  }


  async heartbeat(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    ttlMs: number,
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (connectionToken !== undefined && !validConnectionToken(connectionToken)) {
      throw new StoreError('fenced', 'heartbeat requires a valid connection token');
    }
    const work = async (client: DatabaseClient): Promise<string> => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const result = await client.query<{ lease_until: Date }>(
        `UPDATE connection_leases SET lease_until=now()+$5*interval '1 millisecond',last_heartbeat_at=now()
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4 AND lease_until > now()
           AND ($6::uuid IS NULL OR connection_token=$6::uuid)
         RETURNING lease_until`, [tenantId, alias, instanceId, epoch, ttlMs, connectionToken ?? null]
      );
      const lease = result.rows[0];
      if (!lease) throw new StoreError('fenced', 'heartbeat rejected by lease fencing');
      return lease.lease_until.toISOString();
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }


  async releaseLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (connectionToken !== undefined && !validConnectionToken(connectionToken)) return false;
    const work = async (client: DatabaseClient): Promise<boolean> => {
      const result = await client.query<{ released: boolean }>(
        `WITH released AS (
           UPDATE connection_leases SET lease_until=now()
            WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
              AND ($5::uuid IS NULL OR connection_token=$5::uuid)
            RETURNING 1
         ), released_deliveries AS (
           UPDATE deliveries
         SET ack_deadline_at=LEAST(COALESCE(ack_deadline_at,now()),now()),
             claim_expires_at=now(),updated_at=now()
         WHERE recipient_tenant=$1 AND recipient_alias=$2 AND consumer_instance_id=$3
             AND consumer_epoch=$4 AND status IN ('leased','accepted','started')
             AND EXISTS(SELECT 1 FROM released)
           RETURNING 1
         )
         SELECT EXISTS(SELECT 1 FROM released) AS released`,
        [tenantId, alias, instanceId, epoch, connectionToken ?? null]
      );
      return result.rows[0]?.released === true;
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }


  /**
   * Reclama trabajo para un consumidor, respetando dos cupos separados.
   *
   * `admission.generalCapacity` y `humanReservedCapacity` son capacidades DURABLES, no límites
   * frescos por llamada. Se descuentan las garras vivas bajo el lock por alias. `maxClaims` sólo
   * acota el lote devuelto al llamador. La clase humana sale exclusivamente de la banda de
   * prioridad autenticada en el ingreso; jamás de `body.type`, controlado por productores.
   *
   * El desempate lo sigue haciendo el mecanismo que ya existía (`delivery_lane_fairness`), sólo
   * que su contador pasa a contar rachas de humano en vez de rachas de carril 'interactive'.
   * Es literalmente la misma columna y el mismo default (3): después de 3 reclamos humanos
   * seguidos deja pasar un trabajo no humano, para que la cola de máquina no se muera de hambre.
   * Como reclamar es un UPDATE de una fila, ese "esperar un turno" cuesta milisegundos:
   * el humano nunca queda detrás de la DURACIÓN de una tarea, sólo detrás de un reclamo.
   */
  async claimDeliveries(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    limit = 20,
    ackDeadlineMs = 30_000,
    interactiveBurst = 3,
    admission: DeliveryAdmission = {},
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<ClaimedDeliveryEnvelope[]> {
    const generalCapacity = admission.generalCapacity;
    const humanReservedCapacity = admission.humanReservedCapacity ?? 0;
    const maxClaims = admission.maxClaims ?? Math.min(100, limit + humanReservedCapacity);
    const humanBurst = admission.humanBurst ?? interactiveBurst;
    if (!Number.isSafeInteger(limit) || limit < 0
      || (generalCapacity !== undefined
        && (!Number.isSafeInteger(generalCapacity) || generalCapacity < 0))
      || !Number.isSafeInteger(humanReservedCapacity) || humanReservedCapacity < 0
      || !Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 100
      || (admission.requireDeclaredCapacity !== undefined
        && typeof admission.requireDeclaredCapacity !== 'boolean')
      || !Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0
      || !Number.isSafeInteger(interactiveBurst) || interactiveBurst < 1
      || !Number.isSafeInteger(humanBurst) || humanBurst < 1) {
      throw new StoreError('conflict', 'claim limits and deadlines must be positive');
    }
    if (connectionToken !== undefined && !validConnectionToken(connectionToken)) {
      throw new StoreError('fenced', 'delivery claim requires a valid connection token');
    }
    const work = async (client: DatabaseClient): Promise<ClaimedDeliveryEnvelope[]> => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const lease = await client.query<{ capabilities: unknown }>(
        `SELECT capabilities FROM connection_leases
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4 AND lease_until>now()
           AND ($5::uuid IS NULL OR connection_token=$5::uuid)
         FOR UPDATE`,
        [tenantId, alias, instanceId, epoch, connectionToken ?? null]
      );
      if (lease.rowCount !== 1) throw new StoreError('fenced', 'delivery claim rejected by lease fencing');
      const capabilities = lease.rows[0]?.capabilities;
      const includeRoutingTargets = Array.isArray(capabilities)
        && capabilities.includes('routing_targets_v1');
      // Mismo criterio de compatibilidad que routing_targets: DeliveryEnvelopeSchema es .strict(),
      // así que un adaptador de una imagen anterior rechazaría el sobre entero al ver un campo que
      // no conoce y se quedaría sin consumir NINGUNA entrega. Sólo se manda a quien lo declaró.
      const includeSelfRole = Array.isArray(capabilities)
        && capabilities.includes('agent_identity_v1');
      const includeProfileRuntimeContract = Array.isArray(capabilities)
        && capabilities.includes('agent_profile_adoption_v1');

      await client.query(
        `INSERT INTO delivery_lane_fairness(tenant_id,alias) VALUES($1,$2)
         ON CONFLICT(tenant_id,alias) DO NOTHING`, [tenantId, alias]
      );
      const fairness = await client.query<{ interactive_streak: number }>(
        `SELECT interactive_streak FROM delivery_lane_fairness
         WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias]
      );
      // Misma columna de siempre; lo que cambió es qué cuenta. Antes contaba reclamos
      // consecutivos del carril 'interactive'; ahora cuenta reclamos consecutivos de tráfico
      // humano. El carril dejó de servir como partición porque se hereda literal en cada salto
      // (row.lane en los tres materializeAgent*), así que una cadena de agentes entera viajaba
      let humanStreak = fairness.rows[0]?.interactive_streak ?? 0;
      const claimedRows: DeliveryRow[] = [];

      // Capacidad de concurrencia duradera por agente: limita las entregas activas evaluando
      // las filas en vuelo y respetando de forma aditiva la reserva de prioridad humana.
      /*
       * Hold the durable capacity row through the claim commit. Configuration mutations take
       * `FOR UPDATE` on this same row, so a concurrent reduction either commits before we read
       * the new cap or waits until this claim has committed under the old cap. Lock order here is
       * lease -> fairness -> agent; configuration never takes either of the first two locks.
       */
      const configuredCapacity = await client.query<{ cap: number | null }>(
        `SELECT max_concurrent_deliveries AS cap FROM agents
          WHERE tenant_id=$1 AND alias=$2 FOR SHARE`,
        [tenantId, alias],
      );
      const capacity = await client.query<{
        in_flight: string; human_in_flight: string;
      }>(
        `SELECT
           (SELECT count(*) FROM deliveries d
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('leased','accepted','started')
               AND d.claim_token IS NOT NULL
               AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now()) AS in_flight,
           (SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('leased','accepted','started')
               AND d.claim_token IS NOT NULL
               AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now()
               AND m.priority >= $3) AS human_in_flight`,
        [tenantId, alias, HUMAN_PRIORITY_FLOOR]
      );
      const capacityRow = capacity.rows[0];
      if (capacityRow === undefined) {
        throw new StoreError('conflict', 'delivery consumer capacity could not be evaluated');
      }
      const configured = configuredCapacity.rowCount === 1;
      if (!configured && admission.requireDeclaredCapacity === true) {
        throw new StoreError('conflict', 'delivery consumer is missing its durable agent capacity');
      }
      const concurrencyCap = configured ? configuredCapacity.rows[0]!.cap : null;
      const inFlight = Number(capacityRow.in_flight);
      const humanInFlight = Number(capacityRow.human_in_flight);
      if (!Number.isSafeInteger(inFlight) || inFlight < 0
        || !Number.isSafeInteger(humanInFlight) || humanInFlight < 0
        || humanInFlight > inFlight
        || (concurrencyCap !== null
          && (!Number.isSafeInteger(concurrencyCap) || concurrencyCap < 1))) {
        throw new StoreError('conflict', 'delivery consumer capacity is invalid');
      }

      // Una persona ocupa primero la reserva. Sólo el excedente humano consume capacidad
      // general. La fila de fairness serializa este conteo con todo claim concurrente del alias,
      // así que HTTP, WebSocket, reconexión y varios gateways comparten el mismo presupuesto.
      const reservedInFlight = Math.min(humanInFlight, humanReservedCapacity);
      const generalInFlight = inFlight - reservedInFlight;
      const effectiveGeneralCapacity = generalCapacity === undefined
        ? configured
          ? concurrencyCap ?? Number.POSITIVE_INFINITY
          : limit
        : concurrencyCap === null ? generalCapacity : Math.min(generalCapacity, concurrencyCap);
      let generalRemaining = Math.min(
        maxClaims,
        Math.max(0, effectiveGeneralCapacity - generalInFlight),
      );
      let humanReservedRemaining = Math.min(
        maxClaims,
        Math.max(0, humanReservedCapacity - reservedInFlight),
      );

      /**
       * Reclama exactamente una entrega de la clase pedida, o `undefined` si no hay ninguna
       * disponible (o si otro worker se la llevó primero: SKIP LOCKED).
       *
       * El predicado de clase por prioridad trusted-at-ingress vive en `messages`; el escaneo lo
       * maneja `deliveries_claim_idx`, parcial sobre `status IN ('pending','retry')` y con
       * (tenant, alias, available_at). Por eso el arreglo no fue agregar un índice sino dejar de
       * preguntar dos veces: la versión anterior corría DOS `EXISTS` de sondeo por cada vuelta
       * de cupo, sobre la cola entera del alias, antes de reclamar. Con colas de horas —que es lo
       * que reporta el incidente— eso era el escaneo caro repetido 2·N veces. Ahora se intenta el
       * reclamo directo, que usa el mismo índice y corta en LIMIT 1.
       */
      const claimOne = async (humanOriginated: boolean): Promise<DeliveryRow | undefined> => {
        const claimed = await client.query<DeliveryRow>(
          `WITH picked AS (
             SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('pending','retry') AND d.available_at<=now()
               AND (m.priority >= $5)=$7::boolean
             ORDER BY (m.lane='interactive') DESC,m.priority DESC,d.available_at,d.created_at
             FOR UPDATE OF d SKIP LOCKED LIMIT 1
           ), updated AS (
             UPDATE deliveries d SET status='leased',attempt=d.attempt+1,claimed_at=now(),
               claim_token=gen_random_uuid(),ack_deadline_at=now()+$6*interval '1 millisecond',
               claim_expires_at=now()+$6*interval '1 millisecond',consumer_instance_id=$4,
               consumer_epoch=$3,execution_started_at=NULL,updated_at=now()
             FROM picked p WHERE d.id=p.id RETURNING d.*
           )
           SELECT u.id,u.message_id,u.recipient_tenant,u.recipient_alias,u.status,u.attempt,u.max_attempts,
                  u.last_ack_rank,u.consumer_instance_id,u.consumer_epoch,u.claim_token,u.ack_deadline_at,
                   m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                   m.auth_session_id,m.auth_channel
           FROM updated u JOIN messages m ON m.id=u.message_id`,
          [tenantId, alias, epoch, instanceId, HUMAN_PRIORITY_FLOOR, ackDeadlineMs, humanOriginated]
        );
        return claimed.rows[0];
      };

      for (let index = 0; index < maxClaims; index += 1) {
        const humanSlotFree = humanReservedRemaining > 0 || generalRemaining > 0;
        const agentSlotFree = generalRemaining > 0;
        if (!humanSlotFree && !agentSlotFree) break;
        // El humano gana siempre, salvo que ya haya ganado `humanBurst` veces seguidas: ahí
        // cede exactamente un turno para que el trabajo no humano no se muera de hambre.
        const yieldTurn = humanSlotFree && agentSlotFree && humanStreak >= humanBurst;
        // `true` es la clase humana. Con el cupo general agotado y reserva libre sólo queda esa
        // clase; las máquinas nunca pueden ocupar el reservado.
        const order: boolean[] = !agentSlotFree
          ? [true]
          : yieldTurn ? [false, true] : [true, false];

        let row: DeliveryRow | undefined;
        let claimedHuman = false;
        let yieldedToNobody = false;
        for (const humanOriginated of order) {
          row = await claimOne(humanOriginated);
          if (row !== undefined) {
            claimedHuman = humanOriginated;
            break;
          }
          // Cedimos el turno y no había nadie del otro lado esperándolo. La racha se reinicia
          // acá mismo para no volver a pagar el intento fallido en cada vuelta siguiente.
          if (!humanOriginated && yieldTurn) yieldedToNobody = true;
        }
        // Ni una ni otra clase: o la cola está vacía o todo lo disponible está bloqueado por
        // otro worker, que es lo mismo desde acá — ese trabajo ya lo está tomando alguien.
        if (row === undefined) break;

        claimedRows.push(row);
        if (claimedHuman) {
          if (humanReservedRemaining > 0) humanReservedRemaining -= 1;
          else generalRemaining -= 1;
          // Saturado en el umbral, igual que el scheduler de jobs: la columna es un contador
          // durable y no tiene por qué crecer sin techo cuando un asistente recibe una ráfaga
          // de mensajes de su dueño y no hay trabajo no humano que le dispute el turno.
          humanStreak = yieldedToNobody ? 1 : Math.min(humanBurst, humanStreak + 1);
        } else {
          generalRemaining -= 1;
          humanStreak = 0;
        }
      }
      await client.query(
        `UPDATE delivery_lane_fairness SET interactive_streak=$3,updated_at=now()
         WHERE tenant_id=$1 AND alias=$2`, [tenantId, alias, humanStreak]
      );
      const routingTargets = includeRoutingTargets
        ? await this.routingTargets(client, tenantId, alias)
        : undefined;
      // Una sola lectura por reclamo, no una por entrega: el rol es del alias que reclama, no del
      // mensaje. Se resuelve acá, dentro de la misma transacción, para que el sobre nunca lleve un
      // rol de otro alias.
      const selfRole = includeSelfRole && claimedRows.length > 0
        ? await this.selfRoleFromProfile(client, tenantId, alias)
        : undefined;
      const profileRuntimeContract = includeProfileRuntimeContract && claimedRows.length > 0
        ? await this.profileRuntimeExpectation(client, tenantId, alias)
        : undefined;

      return claimedRows.map((row) => ({
        type: 'delivery',
        version: PROTOCOL_VERSION,
        delivery_id: row.id,
        event_id: row.id,
        message_id: row.message_id,
        request_id: row.request_id,
        trace_id: row.trace_id,
        epoch,
        attempt: row.attempt,
        claim_token: row.claim_token!,
        ack_deadline_at: row.ack_deadline_at!.toISOString(),
        tenant_id: row.tenant_id,
        room_id: row.room_id,
        actor_alias: row.actor_alias,
        recipient_alias: row.recipient_alias,
        body: row.body,
        ...(routingTargets === undefined ? {} : { routing_targets: routingTargets }),
        ...(selfRole === undefined ? {} : { self_role: selfRole }),
        ...(profileRuntimeContract === undefined
          ? {}
          : { profile_runtime_contract: profileRuntimeContract }),
        ...(row.origin ? { origin: row.origin } : {}),
        ...(row.auth_session_id && row.auth_channel ? {
          authenticated_context: {
            session_id: row.auth_session_id,
            channel: row.auth_channel,
            ...(row.origin ? { origin: row.origin } : {})
          }
        } : {})
      }));
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }


  /**
   * Las garras que HOY siguen ocupando la ventana de ACK de un alias, según la base.
   *
   * Existe porque el control de admisión del gateway vivía sólo en la RAM del socket: cada
   * `hello` creaba un `claims: new Map()` vacío y con eso el cupo entero volvía a estar libre.
   * Reproducido por el revisor: con el cupo en 1 y tres entregas encoladas, un adaptador que
   * hace flapping se llevaba una entrega por reconexión. Peor todavía con
   * `renewable_delivery_claims_v1`, cuya razón de ser es CONSERVAR el lease y la época entre
   * reconexiones: ahí las garras viejas siguen vivas en la base y el gateway las olvidaba.
   *
   * Se consulta por (tenant, alias) y NO por (instance_id, época) a propósito. El recurso que se
   * está racionando es "cuánto trabajo de este alias tiene el plazo de ACK corriendo", que es
   * exactamente el número que explotó en el incidente (71 en vuelo). Una garra de una época
   * anterior que todavía no venció ocupa esa ventana igual, aunque este socket no pueda ACKearla,
   * y contarla es lo que evita que reconectar multiplique el cupo.
   *
   * Sin FOR UPDATE ni FOR SHARE: es una foto para decidir cuánto pedir, y el reclamo real vuelve
   * a validar todo bajo lock. Tomar filas bajo lock acá sólo agregaría contención con el reaper.
   */
  async liveDeliveryClaims(
    tenantId: Tenant,
    alias: string,
    limit = 256
  ): Promise<LiveDeliveryClaim[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new StoreError('conflict', 'live claim limit must be a positive integer');
    }
    const rows = await this.pool.query<{
      id: string;
      attempt: number;
      claim_token: string | null;
      ack_deadline_at: Date | null;
      human_originated: boolean;
    }>(
      `SELECT d.id,d.attempt,d.claim_token,d.ack_deadline_at,
              m.priority >= $3 AS human_originated
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
         AND d.status IN ('leased','accepted','started')
         AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now()
       ORDER BY d.ack_deadline_at LIMIT $4`,
      [tenantId, alias, HUMAN_PRIORITY_FLOOR, limit]
    );
    return rows.rows
      .filter((row): row is typeof row & { claim_token: string; ack_deadline_at: Date } =>
        row.claim_token !== null && row.ack_deadline_at !== null)
      .map((row) => ({
        delivery_id: row.id,
        attempt: row.attempt,
        claim_token: row.claim_token,
        ack_deadline_at: row.ack_deadline_at.toISOString(),
        human_originated: row.human_originated === true
      }));
  }


  /**
   * Procesa el ACK de una entrega validando fences de exclusividad, límites de arrendamiento
   * y delegando a `lateTerminalSalvage` si el resultado es terminal pero la exclusividad venció.
   */
  async ackDelivery(
    deliveryId: string,
    tenantId: Tenant,
    alias: string,
    ack: Ack,
    ackDeadlineMs = 30_000,
    leaseCap: DeliveryLeaseCap = {}
  ): Promise<AckResult> {
    if (!ack.claim_token || !ack.attempt) {
      throw new StoreError('fenced', 'ACK requires claim_token and positive attempt');
    }
    if (!Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0) {
      throw new StoreError('conflict', 'ACK deadline must be a positive integer');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const selected = await client.query<
        DeliveryRow & LateResultRow & { claim_live: boolean; execution_started: boolean }
      >(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                d.late_result_at,d.cancelled_at,
                (d.ack_deadline_at>now()) AS claim_live,
                (d.execution_started_at IS NOT NULL) AS execution_started,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                 m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3 FOR UPDATE OF d`,
        [deliveryId, tenantId, alias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found for consumer');
      const safeAckResult = postgresJsonSafe(ack.result) as Record<string, unknown> | undefined;
      const outputs = agentOutputEntries(safeAckResult);
      const notifications = agentNotifyEntries(safeAckResult);
      const runtimeAdoption = profileRuntimeAdoptionEvidence(safeAckResult);
      const persistedResult = sanitizedAckResult(safeAckResult);
      const repeated = await client.query<{
        delivery_id: string;
        status: Ack['status'];
        instance_id: string;
        epoch: string;
        claim_token: string;
        attempt: number;
        applied: boolean;
      }>(
        `SELECT delivery_id,status,instance_id,epoch,claim_token,attempt,applied
         FROM delivery_acks WHERE event_id=$1 LIMIT 1`,
        [ack.event_id]
      );
      const repeatedAck = repeated.rows[0];
      if (repeatedAck) {
        const exactEvent = repeatedAck.delivery_id === deliveryId
          && repeatedAck.status === ack.status
          && repeatedAck.instance_id === ack.instance_id
          && Number(repeatedAck.epoch) === ack.epoch
          && repeatedAck.claim_token === ack.claim_token
          && repeatedAck.attempt === ack.attempt;
        if (!exactEvent) {
          return {
            delivery_id: deliveryId,
            status: row.status,
            applied: false,
            receipt: 'ownership_lost',
          };
        }
        // A terminal or accepted replay is idempotently complete. A repeated
        // started event is handled below only while the exact claim and
        // connection lease remain live, because the client may use that
        // receipt as fresh proof of ownership.
        if (repeatedAck.applied && ack.status !== 'started') {
          const feedback = terminal(ack.status)
            ? await this.delegationFeedbackForAck(client, deliveryId, ack.attempt)
            : {};
          return {
            delivery_id: deliveryId,
            status: row.status,
            applied: false,
            receipt: 'duplicate',
            ...feedback,
          };
        }
        // Un evento EXACTO que ya fue rechazado no se corta acá. Antes sí, y eso convertía el
        // primer rechazo en definitivo: el mismo ACK, con el mismo resultado adentro, reenviado
        // por un adaptador que no se rindió, volvía a caer en `ownership_lost` sin que nadie
        // mirara el contenido. Sigue hacia abajo y lo juzga el mismo camino que a un ACK nuevo;
        // si tampoco es rescatable, el `return` de `!exactClaim` devuelve el mismo receipt de
        // siempre. `insertAck` sube `applied` de false a true si esta vuelta sí se aplica.
      }
      // Una fila terminal sólo admite el replay exacto y aplicado resuelto arriba. En particular,
      // un event_id nuevo con el resto de la correlación vieja NO se guarda como ACK rechazado:
      // eso mutaría el historial tras un resultado final y permitiría poblarlo sin límite durante
      // cada reconnect. Tampoco vuelve a materializar ni reconstruye feedback.
      if (row.status === 'done' || row.status === 'failed') {
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      if (row.claim_token === ack.claim_token && row.attempt === ack.attempt &&
          (row.consumer_instance_id !== ack.instance_id || Number(row.consumer_epoch) !== ack.epoch)) {
        throw new StoreError('fenced', 'ACK identity does not own this delivery claim');
      }
      const exactClaim = row.claim_token === ack.claim_token
        && row.attempt === ack.attempt
        && row.claim_live
        && ['leased', 'accepted', 'started'].includes(row.status);
      if (!exactClaim) {
        // La garra se perdió. El RESULTADO puede seguir valiendo: ver `lateTerminalSalvage`.
        const salvaged = await this.lateTerminalSalvage(
          client, tenantId, alias, row, ack, persistedResult, outputs, notifications
        );
        if (salvaged) return salvaged;
        if (!repeatedAck) await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      const lease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
         AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
      );
      if (lease.rowCount !== 1
        || row.consumer_instance_id !== ack.instance_id
        || Number(row.consumer_epoch) !== ack.epoch) {
        await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      const rank = ackRank(ack.status);
      // Punto durable de no retorno. El SDK nuevo lo fsynca después de reservar la sesión y
      // espera este receipt ANTES de invocar; por eso un crash posterior puede haber tenido
      // efectos y no admite retry automático. COALESCE conserva el primer compromiso del intento.
      const executionStarted = ack.status === 'started' && ack.execution_started === true;
      const leaseCapMs = deliveryLeaseCapMs(row.body, leaseCap);
      // Latido de una entrega en cola ('accepted'): extiende el plazo respetando el leaseCap
      // sin alterar el estado ni registrar inicio de ejecución.
      if (ack.status === 'accepted' && row.status === 'accepted') {
        await client.query(
          `UPDATE deliveries
           SET ack_deadline_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(execution_started_at,claimed_at) + $3*interval '1 millisecond'),
               claim_expires_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(execution_started_at,claimed_at) + $3*interval '1 millisecond'),
               updated_at=now()
           WHERE id=$1 AND status='accepted'`,
          [deliveryId, ackDeadlineMs, leaseCapMs]
        );
        if (!repeatedAck) await this.insertAck(client, row, ack, true, persistedResult, true);
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
           ) VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
          [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
            JSON.stringify({
              ack: ack.status,
              resulting_status: row.status,
              epoch: ack.epoch,
              attempt: ack.attempt,
              lease_renewed: true,
              queued: true,
              ...(repeatedAck ? { duplicate_replay: true } : {})
            })]
        );
        return {
          delivery_id: deliveryId,
          status: 'accepted',
          applied: true,
          receipt: repeatedAck ? 'duplicate' : 'applied',
        };
      }
      if (ack.status === 'started' && row.status === 'started') {
        // El ancla se escribe con el valor que la fila va a TENER después de este UPDATE, no
        // con el que tenía: en PostgreSQL las expresiones del SET leen la fila vieja, y si el
        // ancla de acá y la del reaper no fueran el mismo instante, una entrega podría vencer
        // por el `LEAST` de acá y que el reaper —mirando la otra ancla— la clasificara como
        // "ACK timeout" genérico. Justamente la confusión que este parche viene a evitar.
        // `LEAST` ignora los NULL, así que una fila sin ancla simplemente no tiene techo.
        await client.query(
          `UPDATE deliveries
           SET ack_deadline_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(CASE WHEN $3::boolean THEN COALESCE(execution_started_at,now())
                               ELSE execution_started_at END, claimed_at)
                   + $4*interval '1 millisecond'),
               claim_expires_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(CASE WHEN $3::boolean THEN COALESCE(execution_started_at,now())
                               ELSE execution_started_at END, claimed_at)
                   + $4*interval '1 millisecond'),
               execution_started_at=CASE WHEN $3::boolean
                 THEN COALESCE(execution_started_at,now()) ELSE execution_started_at END,
               updated_at=now()
           WHERE id=$1`,
          [deliveryId, ackDeadlineMs, executionStarted, leaseCapMs]
        );
        // Sin condición: si el evento ya estaba guardado como rechazado y esta vuelta SÍ se
        // aplica, la fila tiene que decirlo. El upsert de `insertAck` sólo sube de false a true,
        // así que para un duplicado ya aplicado esto es un no-op exacto.
        await this.insertAck(client, row, ack, true, persistedResult, true);
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
           ) VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
          [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
            JSON.stringify({
              ack: ack.status,
              resulting_status: row.status,
              epoch: ack.epoch,
              attempt: ack.attempt,
              lease_renewed: true,
              ...(executionStarted ? { execution_started: true } : {}),
              ...(repeatedAck ? { duplicate_replay: true } : {})
            })]
        );
        return {
          delivery_id: deliveryId,
          status: 'started',
          applied: true,
          receipt: repeatedAck ? 'duplicate' : 'applied',
        };
      }
      if (terminal(row.status) || rank <= row.last_ack_rank) {
        await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: terminal(row.status) ? 'ownership_lost' : 'superseded',
        };
      }

      let nextStatus: DeliveryState = ack.status;
      let nextRank = rank;
      let terminalAt = rank === 3 ? 'now()' : 'NULL';
      let terminalError = postgresTextSafe(ack.error);
      let terminalErrorCode = postgresTextSafe(ack.error_code);
      // Si el fallo es ambiguo pero nunca comenzó la ejecución (execution_started_at es null),
      // se permite reintento si quedan intentos disponibles; de lo contrario pasa a dead.
      const ambiguousFailure = ack.status === 'failed'
        && isAmbiguousAckErrorCode(ack.error_code);
      const ambiguousExecution = ambiguousFailure && row.execution_started;
      if (ambiguousExecution) {
        nextStatus = 'dead';
        terminalAt = 'now()';
      } else if (ack.status === 'failed' && (ack.retryable || ambiguousFailure)) {
        if (row.attempt < row.max_attempts) {
          nextStatus = 'retry';
          nextRank = 0;
          terminalAt = 'NULL';
        } else {
          nextStatus = 'dead';
          terminalAt = 'now()';
        }
      }
      if (nextStatus === 'done' && row.body.type === 'agent.fanin') {
        if (outputs.length > 0) {
          nextStatus = 'failed';
          terminalError = 'agent.fanin cannot delegate new messages';
          terminalErrorCode = 'FANIN_REDELEGATION_FORBIDDEN';
        } else if (!textualReply(persistedResult)) {
          nextStatus = 'failed';
          terminalError = 'agent.fanin requires a non-empty final reply';
          terminalErrorCode = 'MISSING_FINAL_REPLY';
        }
      }
      const backoffSeconds = Math.min(60, 2 ** Math.max(0, row.attempt - 1));
      // El PRIMER 'started' ahora también corre el plazo, igual que las renovaciones. Antes no
      // lo movía y la base seguía contando desde el reclamo mientras el gateway, que sí lo
      // corre al ver el ACK aplicado, creía el cupo vivo más tiempo del real: las dos vistas de
      // la misma garra se iban separando por lo que hubiera tardado el arranque. Ahora el
      // instante de referencia es el mismo hecho (el ACK aplicado) en los dos lados.
      await client.query(
         `UPDATE deliveries SET status=$2,last_ack_rank=$3,last_error=$4,result=$5::jsonb,
            available_at=CASE WHEN $2='retry' THEN now()+$6*interval '1 second' ELSE available_at END,
             claimed_at=CASE WHEN $2='retry' THEN NULL ELSE claimed_at END,
             claim_expires_at=CASE WHEN $2='retry' THEN NULL
                                   WHEN $2='started' THEN LEAST(
                                     now()+$7*interval '1 millisecond',
                                     COALESCE(CASE WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                                   ELSE execution_started_at END, claimed_at)
                                       + $9*interval '1 millisecond')
                                   ELSE claim_expires_at END,
             ack_deadline_at=CASE WHEN $2='retry' THEN NULL
                                  WHEN $2='started' THEN LEAST(
                                    now()+$7*interval '1 millisecond',
                                    COALESCE(CASE WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                                  ELSE execution_started_at END, claimed_at)
                                      + $9*interval '1 millisecond')
                                  ELSE ack_deadline_at END,
             execution_started_at=CASE WHEN $2='retry' THEN NULL
                                       WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                       ELSE execution_started_at END,
             claim_token=CASE WHEN $2='retry' THEN NULL ELSE claim_token END,
             consumer_instance_id=CASE WHEN $2='retry' THEN NULL ELSE consumer_instance_id END,
            consumer_epoch=CASE WHEN $2='retry' THEN NULL ELSE consumer_epoch END,
            terminal_at=${terminalAt},updated_at=now() WHERE id=$1`,
        [deliveryId, nextStatus, nextRank, terminalError ?? null,
          persistedResult ? JSON.stringify(persistedResult) : null, backoffSeconds,
          ackDeadlineMs, executionStarted, leaseCapMs]
      );
      if (nextStatus === 'done') {
        await this.recordProfileRuntimeAdoption(
          client, tenantId, alias, row, ack, runtimeAdoption,
        );
      }
      if (nextStatus === 'retry') {
        await client.query(
          `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
           VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
           ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
          [tenantId, `wake-retry:${deliveryId}:${row.attempt}`, row.request_id, row.message_id, deliveryId,
            row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
            JSON.stringify({ recipient_alias: alias, reason: 'delivery_available' }), backoffSeconds]
        );
      }
      // Todo error final deja rastro replayable en dead_letters, no sólo 'dead'.
      //
      // Mantener registro en dead_letters permite que `replayDelivery` funcione tanto
      // para entregas en estado 'failed' como 'dead'.
      //
      // La corrección NO es fusionar 'failed' con 'dead'. Los dos estados los consumen hoy, con
      // significados distintos, `terminal()`, el conteo de fan-in (`status IN ('done','failed',
      // 'dead')`), el CHECK de `deliveries.status`, `DeliveryStateSchema` del protocolo, la serie
      // `cauce_dispatcher_delivery_*` del dispatcher y cuatro vistas de la consola. Fusionarlos
      // borraría la única distinción útil que queda —"el agente declaró un error definitivo" vs
      // "el sistema se dio por vencido"— y dejaría una serie de métrica en cero para siempre, a
      // cambio de nada: lo que hace recuperable a una entrega no es su estado, es tener fila en
      // `dead_letters`. Así que se emite la fila para AMBOS finales de error y se relaja el
      // filtro de `replayDelivery`; el resto del sistema no se entera.
      //
      // `retryable` conserva su único trabajo legítimo: decidir si el bus REINTENTA solo. Deja de
      // decidir si un humano puede rescatar la entrega.
      if (nextStatus === 'dead' || nextStatus === 'failed') {
        await client.query(
          `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
           SELECT $1,$2,$3,m.body,$4 FROM messages m WHERE m.id=$5
           ON CONFLICT(delivery_id) DO NOTHING`,
          [deliveryId, tenantId,
            terminalError ?? terminalErrorCode
              ?? (nextStatus === 'dead'
                ? 'max attempts exhausted'
                : 'non-retryable failure without error text'),
            row.attempt, row.message_id]
        );
      }
      await this.insertAck(client, row, ack, true, persistedResult);
      let notified = { allowed: 0, denied: 0, errors: 0 };
      let delegationRejections: DelegationRejection[] = [];
      let delegationMaterializations: DelegationMaterialization[] = [];
      let chainGate: OpenChainGate | undefined;
      if (terminal(nextStatus)) {
        const policy = await this.loadChainPolicy(client);
        // Proactive egress is a side effect of a terminal turn, not a delegation.
        // The count deliberately stays out of the response disposition below.
        // Se pasa `ambiguousFailure`, NO `ambiguousExecution`: el veto a las notificaciones
        // depende de que el sistema NO SEPA si el trabajo pasó, y eso lo dice el código de error
        // por sí solo. Un ambiguo sin marca de ejecución que además agotó los intentos termina
        // en `dead` igual, y ahí no puede salir un aviso a un humano afirmando que algo se hizo.
        // Con `ambiguousExecution` este veto se habría relajado justo en ese caso.
        notified = await this.materializeAgentNotifications(
          client, row, ack, notifications, ambiguousFailure
        );
        let outputOutcome: AgentOutputOutcome = {
          materialized: 0, suspended: false, rejections: [], materializations: []
        };
        if (nextStatus === 'done' && row.body.type !== 'agent.fanin') {
          outputOutcome = await this.materializeAgentOutputs(client, row, ack, outputs, policy);
        }
        delegationRejections = [...outputOutcome.rejections]
          .sort((left, right) => left.output_index - right.output_index);
        delegationMaterializations = [...outputOutcome.materializations]
          .sort((left, right) => left.output_index - right.output_index);
        chainGate = outputOutcome.gate;
        const materializedOutputs = outputOutcome.materialized;
        // A child that successfully delegated work is not terminal from its
        // parent's perspective. Returning its empty/intermediate ACK here lets
        // the parent close before the delegated descendants finish. The later
        // authenticated agent.response continuation is the logical terminal
        // turn and is the only response that may flow back to the parent.
        //
        // `suspended` entra acá por la misma razón que `materializedOutputs > 0`: una rama que
        // abrió un gate humano NO terminó, está esperando. Devolver su respuesta al padre la
        // daría por cerrada y el padre seguiría delegando sobre una cadena suspendida.
        const responseDisposition: AgentResponseDisposition = materializedOutputs > 0
          || outputOutcome.suspended
          ? 'deferred'
          : await this.materializeAgentResponse(
              client,
              row,
              ack.attempt,
              nextStatus,
              policy,
              persistedResult,
              terminalError,
              terminalErrorCode
            );
        const rootMessageId = this.rootMessageId(row);
        const fanin = await this.materializeAgentFanin(client, rootMessageId);
        if (responseDisposition === 'not_child'
          && (row.body.type === 'agent.fanin' || !fanin.hasFanout)) {
          await this.insertOriginRelay(client, row, nextStatus, {
            ...(persistedResult === undefined ? {} : { result: persistedResult }),
            ...(terminalError === undefined ? {} : { error: terminalError }),
            ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
          });
        }
      }
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
         VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
           JSON.stringify({
             ack: ack.status,
             resulting_status: nextStatus,
             epoch: ack.epoch,
             attempt: ack.attempt,
             ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode }),
             ...(ambiguousExecution ? { ambiguous_execution: true } : {}),
             // El ambiguo que NO llegó a ejecutar se audita aparte para que el operador pueda
             // separar de un vistazo "retenido porque pudo haber corrido" de "reintentado porque
             // no corrió", que son diagnósticos opuestos sobre el mismo código de error.
             ...(ambiguousFailure && !row.execution_started
               ? { ambiguous_without_execution: true }
               : {}),
             ...(notified.allowed + notified.denied + notified.errors === 0
               ? {}
               : {
                 notifications_allowed: notified.allowed,
                 notifications_denied: notified.denied,
                 notifications_failed: notified.errors
               })
           })]
      );
      return {
        delivery_id: deliveryId,
        status: nextStatus,
        applied: true,
        receipt: 'applied',
        // Ausentes cuando no hay nada que decir: agregar claves vacías cambiaría los bytes que
        // el gateway devuelve a TODO ACK, y hay adaptadores viejos comparando la respuesta.
        ...(delegationRejections.length === 0
          ? {}
          : { delegation_rejections: delegationRejections }),
        ...(delegationMaterializations.length === 0
          ? {}
          : { delegation_materializations: delegationMaterializations }),
        ...(chainGate === undefined
          ? {}
          : { chain_gate: { gate_id: chainGate.id, question: chainGate.question } })
      };
    });
  }


  /**
   * Rescata un resultado terminal ('done' o 'failed' con texto) que llega tras expirar la exclusividad,
   * siempre que la entrega no tenga un resultado previo ni haya sido cancelada manualmente.
   */
  private async lateTerminalSalvage(
    client: DatabaseClient,
    tenantId: Tenant,
    alias: string,
    row: DeliveryRow & LateResultRow,
    ack: Ack,
    persistedResult: Record<string, unknown> | undefined,
    outputs: AgentOutputEntry[],
    notifications: AgentNotifyEntry[]
  ): Promise<AckResult | undefined> {
    // S1
    if (ack.status !== 'done' && ack.status !== 'failed') return undefined;
    const reply = textualReply(persistedResult);
    if (!reply) return undefined;
    // S2
    if (outputs.length > 0) return undefined;
    // S5
    if (row.status === 'done' || row.status === 'failed') return undefined;
    if (row.late_result_at !== null) return undefined;
    // Entregas canceladas por un operador no se rescatan para no duplicar respuestas hacia el padre.
    if (row.cancelled_at !== null) return undefined;
    // S6
    if (ack.status === 'failed' && row.status !== 'dead') return undefined;
    // Un ACK que dice pertenecer a un intento que la entrega todavía no alcanzó no es tardío:
    // es imposible. Se rechaza sin mirar nada más.
    if (ack.attempt > row.attempt) return undefined;
    // S4
    const lease = await client.query(
      `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
       AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
    );
    if (lease.rowCount !== 1) return undefined;
    // S3
    const provenance = await this.lateClaimProvenance(client, row, ack);
    if (provenance === 'none') return undefined;

    const salvagedStatus: DeliveryState = ack.status === 'done' ? 'done' : 'dead';
    const terminalError = postgresTextSafe(ack.error);
    const terminalErrorCode = postgresTextSafe(ack.error_code);
    const previousStatus = row.status;

    // `last_ack_rank=3` deja la fila en rango terminal, así que un ACK de rango menor que
    // llegue después se lleva 'superseded' y no vuelve a entrar acá. Los plazos se anulan
    // porque ya no hay garra viva que puedan describir; `claim_token` y el consumidor se
    // CONSERVAN, que es la única traza de quién la tuvo al final.
    await client.query(
      `UPDATE deliveries
       SET status=$2,last_ack_rank=3,last_error=$3,result=$4::jsonb,
           terminal_at=COALESCE(terminal_at,now()),
           late_result_at=now(),late_result_attempt=$5,
           claim_expires_at=NULL,ack_deadline_at=NULL,updated_at=now()
       WHERE id=$1`,
      [row.id, salvagedStatus, terminalError ?? null,
        persistedResult ? JSON.stringify(persistedResult) : null, ack.attempt]
    );

    const relayDisposition = await this.undoDeathNotice(
      client, row, ack, salvagedStatus, previousStatus, persistedResult,
      terminalError, terminalErrorCode
    );

    await this.insertAck(client, row, ack, true, persistedResult);
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'delivery.late_result','allow',$3,$4,$5,$6,$7::jsonb)`,
      [tenantId, alias, row.request_id, row.message_id, row.id, row.trace_id,
        JSON.stringify({
          ack: ack.status,
          resulting_status: salvagedStatus,
          previous_status: previousStatus,
          epoch: ack.epoch,
          attempt: ack.attempt,
          delivery_attempt: row.attempt,
          claim_provenance: provenance,
          reply_characters: reply.length,
          // Lo que el rescate NO hizo. Sin estos dos números no hay forma de saber si la
          // restricción de S2 está tirando trabajo real a la basura.
          skipped_delegations: outputs.length,
          skipped_notifications: notifications.length,
          origin_relay: relayDisposition,
          ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
        })]
    );
    return {
      delivery_id: row.id,
      status: salvagedStatus,
      applied: true,
      // Deliberadamente el mismo receipt que un ACK sano. El contrato de `ack_result` es
      // `.strict()` en el esquema del protocolo: un valor nuevo lo rechazaría el SDK de los 14
      // adaptadores que hoy están en producción con el bundle viejo. Toda la información de
      // "esto fue un rescate" vive en `audit_events`, en `delivery_acks` y en las dos columnas
      // nuevas de `deliveries`, que es donde la mira un operador, no un adaptador.
      receipt: 'applied',
    };
  }


  /**
   * ¿Esta garra existió alguna vez sobre esta entrega?
   *
   * El `claim_token` es un uuid que genera PostgreSQL al arrendar y que nunca sale del dueño de
   * la garra, así que presentarlo ES la prueba — pero sólo si queda registro de que se emitió,
   * y la fila de `deliveries` guarda una sola garra: la última. En 487 de los 495 casos medidos
   * el reaper ya la había rotado.
   *
   * El registro que sí sobrevive es `delivery_acks`: todo ACK de este intento, aplicado o
   * rechazado, dejó ahí su `claim_token`. Se distinguen dos calidades de prueba y las dos se
   * aceptan, pero la auditoría anota cuál fue:
   *   - 'applied': existe un ACK de esa misma garra que el store ACEPTÓ en su momento. Prueba
   *     fuerte: el store mismo verificó la propiedad cuando el plazo estaba vivo. 188/495.
   *   - 'observed': sólo hay ACKs rechazados de esa misma garra. Es prueba débil —la escribió el
   *     propio cliente— pero no está sola: el llamador ya está autenticado como el alias
   *     destinatario (mTLS en el gateway) y S4 exige lease vivo de esa instancia. Lo que un
   *     'observed' habilita, entonces, es que un alias conteste una entrega SUYA que nadie
   *     contestó. Los 307 restantes son este caso, y son 307 corridas de harness pagadas cuyo
   *     ACK fue rechazado desde el primer 'accepted': el alias trabajó de verdad.
   *
   * Endurecerlo a 'applied' solamente costaría el 62% de la recuperación. Queda como palanca
   * obvia si algún día la prioridad se invierte: basta con exigir `=== 'applied'`.
   */
  private async lateClaimProvenance(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack
  ): Promise<LateClaimProvenance> {
    if (row.claim_token === ack.claim_token
      && row.attempt === ack.attempt
      && row.consumer_instance_id === ack.instance_id
      && Number(row.consumer_epoch) === ack.epoch) {
      return 'current';
    }
    const proof = await client.query<{ applied: boolean | null }>(
      `SELECT bool_or(applied) AS applied FROM delivery_acks
       WHERE delivery_id=$1 AND claim_token=$2 AND attempt=$3
         AND instance_id=$4 AND epoch=$5 AND event_id IS DISTINCT FROM $6`,
      [row.id, ack.claim_token, ack.attempt, ack.instance_id, ack.epoch, ack.event_id]
    );
    const applied = proof.rows[0]?.applied ?? null;
    if (applied === null) return 'none';
    return applied ? 'applied' : 'observed';
  }


  /**
   * Deshacer los efectos de la muerte, sin mandarle a nadie dos avisos contradictorios.
   *
   * Al morir por timeout el reaper hace tres cosas: marca `dead`, abre una fila en
   * `dead_letters` y avisa —al padre por `materializeAgentResponse`, o al origen por
   * `insertOriginRelay`. Aceptar el resultado tardío sin tocar esas tres deja al sistema
   * mintiendo en tres lugares distintos, y el peor es el tercero.
   *
   *  1. `dead_letters`. Un 'done' rescatado la RESUELVE (`resolved_at=now()`). No es cosmético:
   *     `replayDelivery` es el botón de "correr esto de nuevo" y una entrega ya contestada
   *     ofrecida al operador para replay es una corrida duplicada esperando a que alguien haga
   *     clic. Un 'failed' rescatado la deja abierta —sigue siendo un fracaso— pero le reescribe
   *     el motivo con el error real del harness en vez del "ACK timeout" genérico.
   *  2. El padre (otro agente) recibe una `agent.response` NUEVA con `outcome='done'` y un
   *     encabezado que dice explícitamente que reemplaza al aviso de fallo anterior. No se
   *     reescribe el mensaje viejo: puede haber sido leído, puede haber sido plegado por el
   *     coalescer, y su auditoría dice 'dead'. Dos mensajes con la corrección explícita es
   *     legible para un LLM; una auditoría que se contradice con el mensaje, no.
   *  3. El origen (una persona en Telegram) es el caso que hay que cuidar de verdad, porque
   *     "falló" seguido de "acá está tu respuesta" sin contexto es peor que el silencio. El
   *     aviso de muerte vive como una fila de `adapter_outbox` con clave de idempotencia
   *     `relay:<delivery>`, y el estado de esa fila decide:
   *       - todavía `pending`/`failed` (nadie lo mandó): se REESCRIBE en el lugar. La persona
   *         recibe UN solo mensaje y es el correcto. Esto es lo que hace que el arreglo no
   *         genere ruido en el caso más común, que es que la respuesta llegue segundos después
   *         del timeout, antes de que el dispatcher drene la cola.
   *       - ya `processing`/`sent`/`dead` (salió o está saliendo): se inserta una fila NUEVA con
   *         otra clave (`relay-late:<delivery>:<intento>`) y la respuesta va precedida de
   *         `LATE_RESULT_HUMAN_NOTICE`. Deliberado y redactado, no un segundo mensaje a secas.
   *     El `FOR UPDATE` sobre la fila del relay serializa esto contra el dispatcher: o lo
   *     agarramos antes de que lo reclame, o esperamos a que lo reclame y entonces corregimos.
   */
  private async undoDeathNotice(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    salvagedStatus: DeliveryState,
    previousStatus: DeliveryState,
    persistedResult: Record<string, unknown> | undefined,
    terminalError: string | undefined,
    terminalErrorCode: string | undefined
  ): Promise<LateRelayDisposition> {
    if (salvagedStatus === 'done') {
      await client.query(
        `UPDATE dead_letters SET resolved_at=now()
         WHERE delivery_id=$1 AND resolved_at IS NULL`,
        [row.id]
      );
    } else if (terminalError !== undefined || terminalErrorCode !== undefined) {
      await client.query(
        `UPDATE dead_letters SET reason=$2 WHERE delivery_id=$1 AND resolved_at IS NULL`,
        [row.id, terminalError ?? terminalErrorCode]
      );
    }
    const policy = await this.loadChainPolicy(client);
    const responseDisposition = await this.materializeAgentResponse(
      client, row, ack.attempt, salvagedStatus, policy, persistedResult,
      terminalError, terminalErrorCode, { previousStatus }
    );
    const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
    if (responseDisposition !== 'not_child'
      || (row.body.type !== 'agent.fanin' && fanin.hasFanout)) {
      return 'skipped';
    }
    return this.insertOriginRelay(client, row, salvagedStatus, {
      ...(persistedResult === undefined ? {} : { result: persistedResult }),
      ...(terminalError === undefined ? {} : { error: terminalError }),
      ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
    }, { previousStatus, attempt: ack.attempt });
  }
}
