import type { DeliveryState, Origin, Tenant } from '@cauce/protocol';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { withAbortableTransaction, withTransaction } from '../db.js';
import { JobsRepository } from './jobs.js';
import {
  UUID_PATTERN, originRelayTenant, type DeliveryRow, type LateRelayDisposition
} from './observability.js';
import { StoreError } from './quotas.js';

export interface OutboxEvent {
  id: string;
  tenant_id: Tenant;
  adapter: string;
  kind: 'wake' | 'origin_relay';
  request_id: string;
  message_id: string;
  delivery_id: string | null;
  trace_id: string;
  origin: Origin | null;
  payload: Record<string, unknown>;
  attempts: number;
  attempt?: number;
  max_attempts: number;
  claimed_by: string;
  claim_token: string;
  claim_expires_at: Date;
  event_id?: string;
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  max_attempts: number;
  claimed_by: string;
  claim_token: string;
  claim_expires_at: Date;
  event_id: string;
  attempt: number;
}

/**
 * Destinatario conectado que puede recibir un wake durable en este instante.
 *
 * El par completo es intencional: los alias no son globales y filtrar sólo por alias permite que
 * una sesión de otro tenant reclame (y queme) el wake de un destinatario desconectado.
 */
export interface WakeOutboxRecipient {
  readonly tenant_id: Tenant;
  readonly alias: string;
  /**
   * Legacy direct store callers may omit the session fields. The gateway runtime always supplies
   * all three; a partial fence is rejected before SQL.
   */
  readonly instance_id?: string;
  readonly epoch?: number;
  readonly connection_token?: string;
}

export interface FencedWakeOutboxRecipient extends WakeOutboxRecipient {
  readonly instance_id: string;
  readonly epoch: number;
  readonly connection_token: string;
}

export interface ConnectionSessionFence {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly instance_id: string;
  readonly epoch: number;
  readonly connection_token: string;
}

export type OutboxRetryResult = 'retry' | 'dead' | 'fenced';

export interface OutboxAck {
  event_id: string;
  attempt: number;
  claim_token: string;
  status: 'sent' | 'retry' | 'dead';
  error?: string;
  retry_after_ms?: number;
  /** Required by the gateway for wake ACKs; omitted only by legacy/direct non-gateway callers. */
  connection?: ConnectionSessionFence;
}

export interface WakeOutboxClaimFence {
  readonly event_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly worker: string;
  readonly connection: ConnectionSessionFence;
}

export function validConnectionToken(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function normalizedWakeRecipients(recipients: readonly WakeOutboxRecipient[]): WakeOutboxRecipient[] {
  if (!Array.isArray(recipients)) {
    throw new StoreError('invalid_input', 'wake outbox recipients must be an array');
  }
  const unique = new Map<string, WakeOutboxRecipient>();
  for (const rawRecipient of recipients as readonly unknown[]) {
    const recipient = rawRecipient !== null && typeof rawRecipient === 'object'
      ? rawRecipient as Record<string, unknown>
      : {};
    const tenant = TenantSchema.safeParse(recipient.tenant_id);
    const alias = AliasSchema.safeParse(recipient.alias);
    if (!tenant.success || !alias.success) {
      throw new StoreError('invalid_input', 'wake outbox recipient identity is invalid');
    }
    const hasAnyFence = recipient.instance_id !== undefined
      || recipient.epoch !== undefined || recipient.connection_token !== undefined;
    const fenced = typeof recipient.instance_id === 'string'
      && recipient.instance_id.length >= 1 && recipient.instance_id.length <= 128
      && Number.isSafeInteger(recipient.epoch) && Number(recipient.epoch) >= 1
      && validConnectionToken(recipient.connection_token);
    if (hasAnyFence && !fenced) {
      throw new StoreError('invalid_input', 'wake outbox recipient session fence is incomplete or invalid');
    }
    const parsed: WakeOutboxRecipient = hasAnyFence
      ? {
        tenant_id: tenant.data,
        alias: alias.data,
        instance_id: String(recipient.instance_id),
        epoch: Number(recipient.epoch),
        connection_token: String(recipient.connection_token),
      }
      : { tenant_id: tenant.data, alias: alias.data };
    const key = `${parsed.tenant_id}\u0000${parsed.alias}`;
    const previous = unique.get(key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(parsed)) {
      throw new StoreError('invalid_input', 'wake outbox recipient has conflicting session fences');
    }
    // Preserve caller order: the gateway rotates this list once per cycle for durable fairness.
    if (previous === undefined) unique.set(key, parsed);
  }
  const normalized = [...unique.values()];
  const fencedCount = normalized.filter((recipient) => recipient.connection_token !== undefined).length;
  if (fencedCount !== 0 && fencedCount !== normalized.length) {
    throw new StoreError('invalid_input', 'wake outbox recipients cannot mix fenced and legacy identities');
  }
  return normalized;
}

/**
 * Aviso que precede a la respuesta cuando el humano YA recibió el "murió". Va en castellano
 * porque es la única cadena generada por el bus que lee una persona (el resto del texto del
 * relay es la respuesta del agente, en el idioma que haya escrito), y porque quien opera esta
 * flota lee castellano. El aviso al agente padre, en cambio, va en inglés como el resto de los
 * textos máquina-a-máquina de este archivo.
 */
export const LATE_RESULT_HUMAN_NOTICE =
  '[respuesta tardía] Esta tarea se había dado por caída y ya te avisamos del fallo. '
  + 'El agente sí la terminó: su ACK final llegó después del plazo y el bus lo aceptó. '
  + 'El aviso de fallo anterior queda sin efecto. Respuesta:';

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function relaySafeResult(
  result: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const output = objectRecord(result?.output);
  if (!result || !output || typeof output.reply !== 'string' || visibleText(output.reply)) return result;
  return { ...result, output: { ...output, reply: null } };
}

/**
 * Antepone un aviso al texto que el puente le va a mostrar a una persona.
 *
 * Va sobre `output.reply` y no como campo aparte porque el puente de Telegram compone el mensaje
 * a partir del primer campo con texto visible (`telegramTextChunks` → `candidate`): un campo
 * nuevo no lo leería nadie. Sólo se aplica a la copia del relay; `deliveries.result` conserva la
 * respuesta del agente tal cual la escribió.
 */
function withReplyNotice(
  result: Record<string, unknown> | undefined,
  notice: string
): Record<string, unknown> | undefined {
  const output = objectRecord(result?.output);
  const reply = visibleText(output?.reply);
  if (!result || !output || !reply) return result;
  return { ...result, output: { ...output, reply: `${notice}\n\n${reply}` } };
}

export function visibleText(value: unknown): string {
  if (typeof value !== 'string' || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(value)) return '';
  return value.trim();
}

export function textualReply(result: Record<string, unknown> | undefined): string {
  const output = objectRecord(result?.output);
  return visibleText(output?.reply);
}

export abstract class OutboxRepository extends JobsRepository {
  protected abstract override assertPermission(
    tenantId: Tenant,
    alias: string,
    permission: 'route' | 'read' | 'control' | 'notify'
  ): Promise<void>;

protected override async insertOriginRelay(
    client: DatabaseClient,
    row: DeliveryRow,
    outcome: string,
    ack: {
      result?: Record<string, unknown> | undefined;
      error?: string | undefined;
      error_code?: string | undefined;
    },
    late?: { previousStatus: DeliveryState; attempt: number }
  ): Promise<LateRelayDisposition> {
    if (!row.origin) return 'skipped';
    const rootMessageId = row.body.type === 'agent.fanin'
      ? this.rootMessageId(row)
      : undefined;
    const missingFinalReply = outcome === 'done' && !textualReply(ack.result);
    const relayOutcome = missingFinalReply ? 'failed' : outcome;
    const relayResult = relaySafeResult(ack.result);
    const visibleError = visibleText(ack.error);
    const visibleErrorCode = visibleText(ack.error_code);
    const relayError = missingFinalReply
      ? 'Successful origin relay requires a non-empty final reply'
      : visibleError || visibleErrorCode
        || (relayOutcome === 'done' ? undefined : `Delivery ended with outcome ${relayOutcome}`);
    const relayErrorCode = missingFinalReply ? 'MISSING_FINAL_REPLY' : visibleErrorCode || undefined;
    const relayTenant = originRelayTenant(row);
    const idempotencyKey = rootMessageId ? `relay-root:${rootMessageId}` : `relay:${row.id}`;
    const correlation = {
      request_id: row.request_id,
      message_id: row.message_id,
      delivery_id: row.id,
      trace_id: row.trace_id,
      ...(rootMessageId ? { root_message_id: rootMessageId } : {})
    };
    const payload = (result: Record<string, unknown> | undefined): string => JSON.stringify({
      outcome: relayOutcome,
      ...(result === undefined ? {} : { result }),
      ...(relayError === undefined ? {} : { error: relayError }),
      ...(relayErrorCode === undefined ? {} : { error_code: relayErrorCode }),
      ...(late === undefined ? {} : {
        late_result: true,
        superseded_outcome: late.previousStatus,
        late_result_attempt: late.attempt
      }),
      correlation
    });
    if (late === undefined) {
      await client.query(
        `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
         VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [relayTenant, row.origin.adapter, idempotencyKey,
          row.request_id, row.message_id, row.id,
          row.trace_id, JSON.stringify(row.origin), payload(relayResult)]
      );
      return 'inserted';
    }
    // El aviso de muerte que ya escribió el reaper (o el ACK terminal anterior) se toma bajo
    // lock: o lo alcanzamos antes de que el dispatcher lo reclame, o esperamos a que lo
    // reclame y entonces sabemos con certeza que la persona lo va a ver.
    const prior = await client.query<{ id: string; status: string }>(
      `SELECT id,status FROM adapter_outbox
       WHERE tenant_id=$1 AND adapter=$2 AND idempotency_key=$3 FOR UPDATE`,
      [relayTenant, row.origin.adapter, idempotencyKey]
    );
    const priorStatus = prior.rows[0]?.status;
    if (priorStatus === 'pending' || priorStatus === 'failed') {
      // Nadie lo mandó todavía: se reescribe en el lugar y la persona recibe UN mensaje, el
      // correcto. Sin encabezado de corrección, porque no hay nada que corregir para ella.
      await client.query(
        `UPDATE adapter_outbox
         SET payload=$2::jsonb,status='pending',available_at=now(),attempts=0,last_error=NULL,
             claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,claimed_at=NULL,dead_at=NULL
         WHERE id=$1`,
        [prior.rows[0]!.id, payload(relayResult)]
      );
      return 'rewritten';
    }
    if (priorStatus === undefined) {
      await client.query(
        `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
         VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [relayTenant, row.origin.adapter, idempotencyKey,
          row.request_id, row.message_id, row.id,
          row.trace_id, JSON.stringify(row.origin), payload(relayResult)]
      );
      return 'inserted';
    }
    // Ya salió o está saliendo. Va un mensaje nuevo, con la respuesta precedida del aviso.
    await client.query(
      `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
       VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
       ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
      [relayTenant, row.origin.adapter, `relay-late:${row.id}:${late.attempt}`,
        row.request_id, row.message_id, row.id,
        row.trace_id, JSON.stringify(row.origin),
        payload(withReplyNotice(relayResult, LATE_RESULT_HUMAN_NOTICE))]
    );
    return 'corrected';
  }

async claimOutbox(
    kind: 'wake' | 'origin_relay',
    worker: string,
    limit = 50,
    leaseMs = 30_000,
    adapter?: string
  ): Promise<ClaimedOutboxEvent[]> {
    return this.claimOutboxMatching(kind, worker, limit, leaseMs, adapter);
  }

/**
   * Reclama wakes sólo para identidades que el gateway observó conectadas.
   *
   * El filtro vive dentro del mismo CTE que toma el lock y aumenta `attempts`: aplicarlo después
   * de `claimOutbox` ya habría consumido un intento de cada alias offline del lote. Una lista vacía
   * falla cerrada y no toca la cola. Los pares se validan y deduplican antes de llegar a SQL.
   */
  async claimWakeOutbox(
    worker: string,
    recipients: readonly WakeOutboxRecipient[],
    limit = 50,
    leaseMs = 30_000,
    signal?: AbortSignal,
  ): Promise<ClaimedOutboxEvent[]> {
    if (leaseMs <= 0 || limit < 1) {
      throw new StoreError('conflict', 'outbox lease and limit must be positive');
    }
    const selected = normalizedWakeRecipients(recipients);
    if (selected.length === 0) return [];
    const work = async (client: DatabaseClient): Promise<ClaimedOutboxEvent[]> => {
      let activeRecipients = selected;
      if (selected[0]?.connection_token !== undefined) {
        const locked = await client.query<{ tenant_id: Tenant; alias: string }>(
          `SELECT requested.tenant_id,requested.alias
             FROM jsonb_to_recordset($1::jsonb) AS requested(
                    tenant_id text,alias text,instance_id text,epoch bigint,connection_token uuid
                  )
             JOIN connection_leases lease
               ON lease.tenant_id=requested.tenant_id AND lease.alias=requested.alias
              AND lease.instance_id=requested.instance_id AND lease.epoch=requested.epoch
              AND lease.connection_token=requested.connection_token AND lease.lease_until>now()
            FOR UPDATE OF lease`,
          [JSON.stringify(selected)],
        );
        const live = new Set(locked.rows.map((recipient) =>
          `${recipient.tenant_id}\u0000${recipient.alias}`));
        activeRecipients = selected.filter((recipient) =>
          live.has(`${recipient.tenant_id}\u0000${recipient.alias}`));
        if (activeRecipients.length === 0) return [];
      }
      const requested = JSON.stringify(activeRecipients.map((recipient, recipientOrder) => ({
        ...recipient,
        recipient_order: recipientOrder,
      })));
      // Retire exhausted expired claims without letting one identity consume the whole cleanup
      // budget. The requested order is the gateway's rotated fairness order.
      await client.query(
        `WITH requested AS (
           SELECT identity.tenant_id,identity.alias,identity.recipient_order
             FROM jsonb_to_recordset($1::jsonb)
                  AS identity(tenant_id text,alias text,instance_id text,epoch bigint,
                              connection_token uuid,recipient_order integer)
         ), expired AS (
           SELECT candidate.id
             FROM requested
             JOIN LATERAL (
               SELECT outbox.id
                 FROM adapter_outbox outbox
                WHERE outbox.kind='wake' AND outbox.tenant_id=requested.tenant_id
                  AND outbox.payload->>'recipient_alias'=requested.alias
                  AND outbox.status='processing'
                  AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now()
                  AND outbox.attempts>=outbox.max_attempts
                ORDER BY outbox.claim_expires_at,outbox.created_at
                FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
             ) candidate ON true
            ORDER BY requested.recipient_order LIMIT $2
         ), dead AS (
           UPDATE adapter_outbox outbox
              SET status='dead',dead_at=now(),claim_expires_at=NULL,
                  last_error='outbox lease expired: max attempts exhausted'
             FROM expired WHERE outbox.id=expired.id
           RETURNING outbox.id,outbox.tenant_id,outbox.adapter,outbox.kind,
                     outbox.payload,outbox.attempts,outbox.last_error
         )
         INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         SELECT id,tenant_id,adapter,kind,last_error,payload,attempts FROM dead
         ON CONFLICT(outbox_id) DO NOTHING`,
        [requested, Math.min(limit, activeRecipients.length, 100)],
      );
      const result = await client.query<ClaimedOutboxEvent>(
        `WITH requested AS (
           SELECT identity.tenant_id,identity.alias,identity.recipient_order
             FROM jsonb_to_recordset($1::jsonb)
                  AS identity(tenant_id text,alias text,instance_id text,epoch bigint,
                              connection_token uuid,recipient_order integer)
         ), picked AS (
           SELECT candidate.id
             FROM requested
             JOIN LATERAL (
               SELECT outbox.id
                 FROM adapter_outbox outbox
                WHERE outbox.kind='wake' AND outbox.tenant_id=requested.tenant_id
                  AND outbox.payload->>'recipient_alias'=requested.alias
                  AND (
                    (outbox.status IN ('pending','failed') AND outbox.available_at<=now())
                    OR (outbox.status='processing'
                        AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now())
                  )
                  AND outbox.attempts<outbox.max_attempts
                ORDER BY CASE WHEN outbox.status='processing'
                              THEN outbox.claim_expires_at ELSE outbox.available_at END,
                         outbox.created_at
                FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
             ) candidate ON true
            ORDER BY requested.recipient_order LIMIT $3
         )
         UPDATE adapter_outbox outbox
            SET status='processing',attempts=outbox.attempts+1,claimed_at=now(),
                claimed_by=$2,claim_token=gen_random_uuid(),
                claim_expires_at=now()+$4*interval '1 millisecond',last_error=NULL
           FROM picked WHERE outbox.id=picked.id
         RETURNING outbox.id,outbox.id AS event_id,outbox.tenant_id,outbox.adapter,outbox.kind,
                   outbox.request_id,outbox.message_id,outbox.delivery_id,outbox.trace_id,
                   outbox.origin,outbox.payload,outbox.attempts,outbox.max_attempts,
                   outbox.claimed_by,outbox.claim_token,outbox.claim_expires_at,
                   outbox.attempts AS attempt`,
        [requested, worker, Math.min(limit, activeRecipients.length), leaseMs],
      );
      return result.rows;
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }

/** Revalidates and renews one exact wake immediately before the gateway emits its frame. */
  async renewWakeOutbox(
    fence: WakeOutboxClaimFence,
    leaseMs = 30_000,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(fence.attempt) || fence.attempt < 1 || leaseMs <= 0
        || !fence.claim_token || !fence.worker
        || !validConnectionToken(fence.connection.connection_token)) return false;
    const work = async (client: DatabaseClient): Promise<boolean> => {
      const lease = await client.query(
        `SELECT 1 FROM connection_leases
          WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
            AND connection_token=$5::uuid AND lease_until>now()
          FOR UPDATE`,
        [
          fence.connection.tenant_id,
          fence.connection.alias,
          fence.connection.instance_id,
          fence.connection.epoch,
          fence.connection.connection_token,
        ],
      );
      if (lease.rowCount !== 1) return false;
      const renewed = await client.query(
        `UPDATE adapter_outbox
            SET claim_expires_at=now()+$5*interval '1 millisecond'
          WHERE id=$1 AND kind='wake' AND status='processing' AND attempts=$2
            AND claim_token=$3::uuid AND claimed_by=$4 AND claim_expires_at>now()
            AND tenant_id=$6 AND payload->>'recipient_alias'=$7
          RETURNING 1`,
        [
          fence.event_id,
          fence.attempt,
          fence.claim_token,
          fence.worker,
          leaseMs,
          fence.connection.tenant_id,
          fence.connection.alias,
        ],
      );
      return renewed.rowCount === 1;
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }

private async claimOutboxMatching(
    kind: 'wake' | 'origin_relay',
    worker: string,
    limit: number,
    leaseMs: number,
    adapter?: string,
    wakeRecipients?: readonly WakeOutboxRecipient[]
  ): Promise<ClaimedOutboxEvent[]> {
    if (leaseMs <= 0 || limit < 1) throw new StoreError('conflict', 'outbox lease and limit must be positive');
    if (wakeRecipients !== undefined && kind !== 'wake') {
      throw new StoreError('invalid_input', 'recipient filtering is valid only for wake outbox claims');
    }
    const wakeRecipientFilter = wakeRecipients === undefined ? null : JSON.stringify(wakeRecipients);
    return withTransaction(this.pool, async (client) => {
      // A claimed or terminal final response supersedes an unclaimed ACK, plus
      // any expired ACK claim. Close it durably so it cannot arrive after the final.
      if (kind === 'origin_relay' && (adapter === undefined || adapter === 'telegram')) {
        await client.query(
          `WITH superseded AS (
           SELECT acknowledgement.id
           FROM adapter_outbox acknowledgement
           WHERE acknowledgement.kind='origin_relay'
             AND acknowledgement.adapter='telegram'
             AND acknowledgement.payload->>'relay_kind'='ack'
             AND (
               acknowledgement.status IN ('pending','failed')
               OR (
                 acknowledgement.status='processing'
                 AND COALESCE(
                   acknowledgement.claim_expires_at,
                   acknowledgement.claimed_at,
                   acknowledgement.created_at
                 )<=now()
               )
             )
             AND EXISTS (
               SELECT 1
               FROM adapter_outbox final
               WHERE final.tenant_id=acknowledgement.tenant_id
                 AND final.adapter=acknowledgement.adapter
                 AND final.kind=acknowledgement.kind
                 AND final.id<>acknowledgement.id
                 AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                 AND final.status IN ('processing','sent','dead')
                 AND COALESCE(
                   final.payload#>>'{correlation,root_message_id}',
                   final.payload#>>'{correlation,message_id}'
                 )=COALESCE(
                   acknowledgement.payload#>>'{correlation,root_message_id}',
                   acknowledgement.payload#>>'{correlation,message_id}'
                 )
             )
           ORDER BY acknowledgement.created_at
           FOR UPDATE OF acknowledgement SKIP LOCKED
           LIMIT $1
         ), dead AS (
           UPDATE adapter_outbox acknowledgement SET
             status='dead',dead_at=now(),claim_expires_at=NULL,
             last_error='Telegram acceptance ACK was superseded by a claimed or terminal final relay'
           FROM superseded
           WHERE acknowledgement.id=superseded.id
           RETURNING acknowledgement.id,acknowledgement.tenant_id,
                     acknowledgement.adapter,acknowledgement.kind,
                     acknowledgement.payload,acknowledgement.attempts,
                     acknowledgement.last_error
         )
         INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         SELECT id,tenant_id,adapter,kind,last_error,payload,attempts FROM dead
           ON CONFLICT(outbox_id) DO NOTHING`,
          [Math.min(limit, 100)]
        );
      }
      // Expired final attempts cannot be claimed again, but they must not remain processing
      // forever. Move them to the durable DLQ in the same transaction as the next claim.
      await client.query(
        `WITH expired AS (
           SELECT outbox.id FROM adapter_outbox outbox
           WHERE outbox.kind=$1 AND outbox.status='processing'
             AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now()
             AND outbox.attempts>=outbox.max_attempts
             AND ($3::text IS NULL OR outbox.adapter=$3)
             AND ($4::jsonb IS NULL OR EXISTS (
               SELECT 1
               FROM jsonb_to_recordset($4::jsonb) AS recipient(tenant_id text, alias text)
               WHERE recipient.tenant_id=outbox.tenant_id
                 AND recipient.alias=outbox.payload->>'recipient_alias'
             ))
           ORDER BY outbox.claim_expires_at FOR UPDATE OF outbox SKIP LOCKED LIMIT $2
         ), dead AS (
           UPDATE adapter_outbox outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,
             last_error='outbox lease expired: max attempts exhausted'
           FROM expired WHERE outbox.id=expired.id
           RETURNING outbox.id,outbox.tenant_id,outbox.adapter,outbox.kind,
                     outbox.payload,outbox.attempts,outbox.last_error
         )
         INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         SELECT id,tenant_id,adapter,kind,last_error,payload,attempts FROM dead
         ON CONFLICT(outbox_id) DO NOTHING`,
        [kind, Math.min(limit, 100), adapter ?? null, wakeRecipientFilter]
      );
      const result = await client.query<ClaimedOutboxEvent>(
        `WITH picked AS (
           SELECT outbox.id
           FROM adapter_outbox outbox
           CROSS JOIN LATERAL (
             SELECT CASE
               WHEN outbox.adapter='telegram'
                 AND outbox.kind='origin_relay'
                 AND COALESCE(
                   outbox.payload#>>'{correlation,root_message_id}',
                   outbox.payload#>>'{correlation,message_id}'
                 ) IS NOT NULL
               THEN pg_try_advisory_xact_lock(hashtextextended(
                 'telegram-origin-relay:'
                 || COALESCE(
                   outbox.payload#>>'{correlation,root_message_id}',
                   outbox.payload#>>'{correlation,message_id}'
                 ),
                 0
               ))
               ELSE true
             END AS acquired
           ) relay_fence
           LEFT JOIN LATERAL (
             SELECT acknowledgement.status
             FROM adapter_outbox acknowledgement
             WHERE outbox.adapter='telegram'
               AND outbox.kind='origin_relay'
               AND outbox.payload->>'relay_kind' IS DISTINCT FROM 'ack'
               AND acknowledgement.tenant_id=outbox.tenant_id
               AND acknowledgement.adapter=outbox.adapter
               AND acknowledgement.kind=outbox.kind
               AND acknowledgement.id<>outbox.id
               AND acknowledgement.payload->>'relay_kind'='ack'
               AND COALESCE(
                 acknowledgement.payload#>>'{correlation,root_message_id}',
                 acknowledgement.payload#>>'{correlation,message_id}'
               )=COALESCE(
                 outbox.payload#>>'{correlation,root_message_id}',
                 outbox.payload#>>'{correlation,message_id}'
               )
             ORDER BY acknowledgement.created_at
             LIMIT 1
             FOR UPDATE OF acknowledgement
           ) acknowledgement_fence ON true
            WHERE outbox.kind=$1 AND (
                (outbox.status IN ('pending','failed') AND outbox.available_at<=now())
                OR (outbox.status='processing'
                    AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now())
              )
              AND outbox.attempts<outbox.max_attempts
              AND ($5::text IS NULL OR outbox.adapter=$5)
              AND ($6::jsonb IS NULL OR EXISTS (
                SELECT 1
                FROM jsonb_to_recordset($6::jsonb) AS recipient(tenant_id text, alias text)
                WHERE recipient.tenant_id=outbox.tenant_id
                  AND recipient.alias=outbox.payload->>'recipient_alias'
              ))
              AND relay_fence.acquired
              AND (
                outbox.adapter<>'telegram'
                OR outbox.kind<>'origin_relay'
                OR (
                  outbox.payload->>'relay_kind'='ack'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM adapter_outbox final
                    WHERE final.tenant_id=outbox.tenant_id
                      AND final.adapter=outbox.adapter
                      AND final.kind=outbox.kind
                      AND final.id<>outbox.id
                      AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                      AND final.status IN ('processing','sent','dead')
                      AND COALESCE(
                        final.payload#>>'{correlation,root_message_id}',
                        final.payload#>>'{correlation,message_id}'
                      )=COALESCE(
                        outbox.payload#>>'{correlation,root_message_id}',
                        outbox.payload#>>'{correlation,message_id}'
                      )
                  )
                )
                OR (
                  outbox.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                  AND (
                    acknowledgement_fence.status IS NULL
                    OR acknowledgement_fence.status IN ('sent','dead')
                  )
                )
              )
            ORDER BY CASE WHEN outbox.status='processing'
                          THEN outbox.claim_expires_at ELSE outbox.available_at END,
                     outbox.created_at
            FOR UPDATE OF outbox SKIP LOCKED LIMIT $3
           )
           UPDATE adapter_outbox o SET status='processing',attempts=o.attempts+1,claimed_at=now(),
            claimed_by=$2,claim_token=gen_random_uuid(),
            claim_expires_at=now()+$4*interval '1 millisecond',last_error=NULL
          FROM picked p WHERE o.id=p.id
          RETURNING o.id,o.id AS event_id,o.tenant_id,o.adapter,o.kind,o.request_id,o.message_id,o.delivery_id,
                    o.trace_id,o.origin,o.payload,o.attempts,o.max_attempts,o.claimed_by,
                    o.claim_token,o.claim_expires_at,o.attempts AS attempt`,
        [kind, worker, limit, leaseMs, adapter ?? null, wakeRecipientFilter]
      );
      return result.rows;
    });
  }

async ackOutbox(
    ack: OutboxAck,
    signal?: AbortSignal,
  ): Promise<{ status: 'sent' | 'failed' | 'dead'; applied: boolean }> {
    if (!Number.isInteger(ack.attempt) || ack.attempt < 1 || !ack.claim_token) {
      throw new StoreError('fenced', 'outbox ACK requires claim token and positive attempt');
    }
    if (ack.connection !== undefined && !validConnectionToken(ack.connection.connection_token)) {
      return { status: 'failed', applied: false };
    }
    const work = async (client: DatabaseClient): Promise<{
      status: 'sent' | 'failed' | 'dead'; applied: boolean;
    }> => {
      if (ack.connection !== undefined) {
        const lease = await client.query(
          `SELECT 1 FROM connection_leases
            WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
              AND connection_token=$5::uuid AND lease_until>now()
            FOR UPDATE`,
          [
            ack.connection.tenant_id,
            ack.connection.alias,
            ack.connection.instance_id,
            ack.connection.epoch,
            ack.connection.connection_token,
          ],
        );
        if (lease.rowCount !== 1) return { status: 'failed', applied: false };
      }
      const selected = await client.query<{
        id: string; tenant_id: Tenant; adapter: string; kind: string; payload: Record<string, unknown>;
        attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,adapter,kind,payload,attempts,max_attempts
         FROM adapter_outbox WHERE id=$1 AND status='processing' AND claim_token=$2
           AND attempts=$3 AND claim_expires_at>now() FOR UPDATE`,
        [ack.event_id, ack.claim_token, ack.attempt]
      );
      const event = selected.rows[0];
      if (!event) return { status: 'failed', applied: false };
      if (ack.connection !== undefined && (
        event.kind !== 'wake'
        || event.tenant_id !== ack.connection.tenant_id
        || event.payload.recipient_alias !== ack.connection.alias
      )) return { status: 'failed', applied: false };
      if (ack.status === 'sent') {
        await client.query(
          `UPDATE adapter_outbox SET status='sent',sent_at=now(),claim_expires_at=NULL WHERE id=$1`,
          [event.id]
        );
        return { status: 'sent', applied: true };
      }
      const reason = (ack.error ?? (ack.status === 'dead' ? 'worker rejected outbox event' : 'outbox retry')).slice(0, 2_000);
      if (ack.status === 'dead' || event.attempts >= event.max_attempts) {
        await client.query(
          `UPDATE adapter_outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,last_error=$2
           WHERE id=$1`, [event.id, reason]
        );
        await client.query(
          `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(outbox_id) DO NOTHING`,
          [event.id, event.tenant_id, event.adapter, event.kind, reason,
            JSON.stringify(event.payload), event.attempts]
        );
        return { status: 'dead', applied: true };
      }
      await client.query(
        `UPDATE adapter_outbox SET status='failed',available_at=now()+$2*interval '1 millisecond',
           claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,last_error=$3 WHERE id=$1`,
        [event.id, Math.max(0, ack.retry_after_ms ?? 250), reason]
      );
      return { status: 'failed', applied: true };
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }

async completeOutbox(id: string, worker?: string, claimToken?: string): Promise<boolean> {
    if (!worker || !claimToken) return false;
    const result = await this.pool.query(
      `UPDATE adapter_outbox SET status='sent',sent_at=now(),claim_expires_at=NULL
       WHERE id=$1 AND status='processing' AND claimed_by=$2 AND claim_token=$3
         AND claim_expires_at>now()`, [id, worker, claimToken]
    );
    return result.rowCount === 1;
  }

async retryOutbox(
    id: string,
    worker?: string,
    claimToken?: string,
    delayMs = 250,
    error = 'outbox delivery failed'
  ): Promise<OutboxRetryResult> {
    if (!worker || !claimToken) return 'fenced';
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; tenant_id: Tenant; adapter: string; kind: string;
        payload: Record<string, unknown>; attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,adapter,kind,payload,attempts,max_attempts
         FROM adapter_outbox WHERE id=$1 AND status='processing' AND claimed_by=$2
           AND claim_token=$3 AND claim_expires_at>now() FOR UPDATE`,
        [id, worker, claimToken]
      );
      const event = selected.rows[0];
      if (!event) return 'fenced';
      const reason = error.slice(0, 2_000);
      if (event.attempts >= event.max_attempts) {
        await client.query(
          `UPDATE adapter_outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,
             last_error=$2 WHERE id=$1`, [id, reason]
        );
        await client.query(
          `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(outbox_id) DO NOTHING`,
          [id, event.tenant_id, event.adapter, event.kind, reason, JSON.stringify(event.payload), event.attempts]
        );
        return 'dead';
      }
      await client.query(
        `UPDATE adapter_outbox SET status='failed',available_at=now()+$2*interval '1 millisecond',
           claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,last_error=$3
         WHERE id=$1`, [id, Math.max(0, delayMs), reason]
      );
      return 'retry';
    });
  }

async retryExpiredOutbox(limit = 100): Promise<{ retried: number; dead: number }> {
    return withTransaction(this.pool, async (client) => {
      const expired = await client.query<{
        id: string; tenant_id: Tenant; adapter: string; kind: string;
        payload: Record<string, unknown>; attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,adapter,kind,payload,attempts,max_attempts
          FROM adapter_outbox WHERE status='processing'
            AND COALESCE(claim_expires_at,claimed_at,created_at)<=now()
          ORDER BY COALESCE(claim_expires_at,claimed_at,created_at)
          FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]
      );
      let retried = 0;
      let dead = 0;
      for (const event of expired.rows) {
        if (event.attempts >= event.max_attempts) {
          const reason = 'outbox lease expired: max attempts exhausted';
          await client.query(
            `UPDATE adapter_outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,
               last_error=$2 WHERE id=$1`, [event.id, reason]
          );
          await client.query(
            `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(outbox_id) DO NOTHING`,
            [event.id, event.tenant_id, event.adapter, event.kind, reason,
              JSON.stringify(event.payload), event.attempts]
          );
          dead += 1;
        } else {
          await client.query(
            `UPDATE adapter_outbox SET status='failed',available_at=now(),claimed_by=NULL,
               claim_token=NULL,claim_expires_at=NULL,last_error='outbox lease expired'
             WHERE id=$1`, [event.id]
          );
          retried += 1;
        }
      }
      return { retried, dead };
    });
  }

async listOutbox(kind?: 'wake' | 'origin_relay'): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id,tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,
              origin,payload,status,attempts,max_attempts,available_at,claimed_by,claimed_at,
              claim_expires_at,last_error,created_at,sent_at,dead_at
       FROM adapter_outbox WHERE ($1::text IS NULL OR kind=$1) ORDER BY created_at`, [kind ?? null]
    );
    return result.rows;
  }

async status(actorTenant?: Tenant, actorAlias?: string, outboxStuckAfterMs = 60_000): Promise<Record<string, number>> {
    if (!Number.isFinite(outboxStuckAfterMs) || outboxStuckAfterMs < 0) {
      throw new StoreError('conflict', 'outbox stuck threshold must be non-negative');
    }
    if (actorTenant !== undefined && actorAlias !== undefined) {
      await this.assertPermission(actorTenant, actorAlias, 'read');
    }
    const result = await this.pool.query<{
      online: string; queued: string; dead: string; outbox: string;
      outbox_stuck_wake: string; outbox_stuck_origin_relay: string;
    }>(
      `SELECT
        (SELECT count(*) FROM connection_leases l WHERE lease_until>now() AND ($1::text IS NULL OR l.tenant_id=$1 OR EXISTS (
           SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=l.tenant_id
             AND a.enabled AND a.allow_read))) AS online,
        (SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ('pending','retry','leased','accepted','started') AND ($1::text IS NULL
           OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                AND source_member.room_id=m.room_id AND source_member.alias=$2
                AND source_member.enabled AND m.tenant_id=$1)
           OR (d.recipient_tenant=$1 AND d.recipient_alias=$2 AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read))))) AS queued,
        (SELECT count(*) FROM dead_letters dl
         LEFT JOIN deliveries d ON d.id=dl.delivery_id LEFT JOIN messages m ON m.id=d.message_id
         LEFT JOIN jobs j ON j.id=dl.job_id
         WHERE dl.resolved_at IS NULL AND ($1::text IS NULL OR j.tenant_id=$1
           OR (d.recipient_tenant=$1 AND d.recipient_alias=$2)
           OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                AND source_member.room_id=m.room_id AND source_member.alias=$2
                AND source_member.enabled AND m.tenant_id=$1))) AS dead,
        (SELECT count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
         WHERE o.status IN ('pending','failed','processing') AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                 AND source_member.room_id=m.room_id AND source_member.alias=$2
                 AND source_member.enabled AND m.tenant_id=$1)
            OR EXISTS (SELECT 1 FROM deliveries participant WHERE participant.id=o.delivery_id
                 AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2))) AS outbox,
        (SELECT count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
         WHERE o.kind='wake' AND (
             (o.status='processing' AND COALESCE(o.claim_expires_at,o.claimed_at,o.created_at)<=now())
             OR (o.status IN ('pending','failed')
                 AND o.available_at<=now()-$3*interval '1 millisecond')
           ) AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                 AND source_member.room_id=m.room_id AND source_member.alias=$2
                 AND source_member.enabled AND m.tenant_id=$1)
            OR EXISTS (SELECT 1 FROM deliveries participant WHERE participant.id=o.delivery_id
                 AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2))) AS outbox_stuck_wake,
        (SELECT count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
         WHERE o.kind='origin_relay' AND (
             (o.status='processing' AND COALESCE(o.claim_expires_at,o.claimed_at,o.created_at)<=now())
             OR (o.status IN ('pending','failed')
                 AND o.available_at<=now()-$3*interval '1 millisecond')
           ) AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                 AND source_member.room_id=m.room_id AND source_member.alias=$2
                 AND source_member.enabled AND m.tenant_id=$1)
            OR EXISTS (SELECT 1 FROM deliveries participant WHERE participant.id=o.delivery_id
                 AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2))) AS outbox_stuck_origin_relay`,
      [actorTenant ?? null, actorAlias ?? null, outboxStuckAfterMs]
    );
    const row = result.rows[0]!;
    return {
      online: Number(row.online),
      queued: Number(row.queued),
      dead_letters: Number(row.dead),
      outbox_pending: Number(row.outbox),
      outbox_stuck_wake: Number(row.outbox_stuck_wake),
      outbox_stuck_origin_relay: Number(row.outbox_stuck_origin_relay)
    };
  }

  /**
   * Autorización compartida por las DOS operaciones de operador sobre una entrega ajena:
   * `replayDelivery` y `cancelDelivery`. Es deliberado que sean la misma: las dos mueven el
   * estado terminal de una entrega que el operador no emitió, y tener dos criterios distintos
   * garantizaría que uno de los dos se quede viejo.
   *
   * Se responde `not_found` (nunca `forbidden`) para no confirmar la existencia de entregas
   * fuera del alcance del actor.
   */
  protected async assertReplayAuthorization(
    client: DatabaseClient,
    actorTenant: Tenant,
    actorAlias: string,
    row: {
      recipient_tenant: Tenant; recipient_alias: string;
      tenant_id: Tenant; room_id: string; actor_alias: string;
    }
  ): Promise<void> {
    const denied = (): never => {
      throw new StoreError('not_found', 'delivery not found or not visible');
    };
    const actorControl = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND role.allow_control
       ORDER BY membership.tenant_id,membership.room_id,membership.alias
       FOR SHARE OF membership,role,tenant,room`,
      [actorTenant, actorAlias]
    );
    if (actorControl.rowCount === 0) denied();

    const sourceRoute = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.room_id=$2 AND membership.alias=$3
         AND membership.enabled AND tenant.enabled AND room.enabled AND role.allow_route
       FOR SHARE OF membership,role,tenant,room`,
      [row.tenant_id, row.room_id, row.actor_alias]
    );
    if (sourceRoute.rowCount === 0) denied();

    const recipient = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       ORDER BY membership.tenant_id,membership.room_id,membership.alias
       FOR SHARE OF membership,tenant,room`,
      [row.recipient_tenant, row.recipient_alias]
    );
    if (recipient.rowCount === 0) denied();

    if (row.tenant_id !== row.recipient_tenant) {
      const route = await client.query(
        `SELECT 1 FROM acl_edges edge
         JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
         JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
           AND edge.enabled AND edge.allow_route
           AND source_tenant.enabled AND target_tenant.enabled
           AND (source_tenant.is_hub OR target_tenant.is_hub)
         FOR SHARE OF edge,source_tenant,target_tenant`,
        [row.tenant_id, row.recipient_tenant]
      );
      if (route.rowCount === 0) denied();
    }

    if (row.recipient_tenant === actorTenant) return;
    if (row.tenant_id === actorTenant) {
      const sourceVisibility = await client.query(
        `SELECT 1 FROM memberships membership
         JOIN tenants tenant ON tenant.id=membership.tenant_id
         JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
         WHERE membership.tenant_id=$1 AND membership.room_id=$2 AND membership.alias=$3
           AND membership.enabled AND tenant.enabled AND room.enabled
         FOR SHARE OF membership,tenant,room`,
        [actorTenant, row.room_id, actorAlias]
      );
      if (sourceVisibility.rowCount !== 0) return;
    }

    const controlEdge = await client.query(
      `SELECT 1 FROM acl_edges edge
       JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
       JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
       WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
         AND edge.enabled AND edge.allow_control
         AND source_tenant.enabled AND target_tenant.enabled
         AND (source_tenant.is_hub OR target_tenant.is_hub)
       FOR SHARE OF edge,source_tenant,target_tenant`,
      [actorTenant, row.recipient_tenant]
    );
    if (controlEdge.rowCount === 0) denied();
  }

  /**
   * Reencola a mano una entrega que terminó en error.
   *
   * El filtro es `status IN ('dead','failed')` y no `status='dead'` porque los dos son finales de
   * ERROR y la diferencia entre ellos la elige el agente que falló (`ack.retryable`), no el
   * operador. Con el filtro viejo, 197 entregas de producción quedaron sin botón de rescate por
   * una decisión que tomó el proceso que se rompió. Ver el comentario largo de `ackDelivery`
   * junto al INSERT en `dead_letters`.
   *
   * El JOIN con `dead_letters` se conserva y sigue siendo el candado de idempotencia: es la fila
   * que se marca `resolved_at` acá dentro, en la misma transacción que crea el clon, y sin ella
   * dos operadores simultáneos crearían dos clones. La migración 018_terminal_recovery_backfill hace el backfill de las
   * entregas terminales que quedaron sin esa fila, incluidas las que un humano marcó `dead` a
   * mano en psql.
   */
  async replayDelivery(deliveryId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; message_id: string; dead_letter_id: string;
        recipient_tenant: Tenant; recipient_alias: string; max_attempts: number;
        request_id: string; trace_id: string; tenant_id: Tenant; room_id: string; actor_alias: string;
        dead_letter_resolved_at: Date | null;
      }>(
        `SELECT d.id,d.message_id,dl.id AS dead_letter_id,d.recipient_tenant,d.recipient_alias,d.max_attempts,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
                dl.resolved_at AS dead_letter_resolved_at
         FROM deliveries d
         JOIN messages m ON m.id=d.message_id
         JOIN dead_letters dl ON dl.delivery_id=d.id
         WHERE d.id=$1 AND d.status IN ('dead','failed')
           AND EXISTS (
             SELECT 1 FROM memberships actor_member
             JOIN role_policies role ON role.role=actor_member.role
             JOIN tenants operator_tenant ON operator_tenant.id=actor_member.tenant_id
             JOIN rooms operator_room
               ON operator_room.id=actor_member.room_id AND operator_room.tenant_id=actor_member.tenant_id
             WHERE actor_member.tenant_id=$2 AND actor_member.alias=$3 AND actor_member.enabled
               AND operator_tenant.enabled AND operator_room.enabled AND role.allow_control
           )
           AND EXISTS (
             SELECT 1 FROM memberships source_actor
             JOIN role_policies source_role ON source_role.role=source_actor.role
             JOIN tenants source_tenant ON source_tenant.id=source_actor.tenant_id
             JOIN rooms source_room
               ON source_room.id=source_actor.room_id AND source_room.tenant_id=source_actor.tenant_id
             WHERE source_actor.tenant_id=m.tenant_id AND source_actor.room_id=m.room_id
               AND source_actor.alias=m.actor_alias AND source_actor.enabled
               AND source_role.allow_route AND source_tenant.enabled AND source_room.enabled
           )
           AND EXISTS (
             SELECT 1 FROM memberships recipient
             JOIN tenants recipient_tenant ON recipient_tenant.id=recipient.tenant_id
             JOIN rooms recipient_room
               ON recipient_room.id=recipient.room_id AND recipient_room.tenant_id=recipient.tenant_id
             WHERE recipient.tenant_id=d.recipient_tenant AND recipient.alias=d.recipient_alias
               AND recipient.enabled AND recipient_tenant.enabled AND recipient_room.enabled
           )
           AND (
             m.tenant_id=d.recipient_tenant
             OR EXISTS (
               SELECT 1 FROM acl_edges route_edge
               JOIN tenants source_tenant ON source_tenant.id=route_edge.from_tenant
               JOIN tenants target_tenant ON target_tenant.id=route_edge.to_tenant
               WHERE route_edge.from_tenant=m.tenant_id AND route_edge.to_tenant=d.recipient_tenant
                 AND route_edge.enabled AND route_edge.allow_route
                 AND source_tenant.enabled AND target_tenant.enabled
                 AND (source_tenant.is_hub OR target_tenant.is_hub)
             )
           )
           AND (
            d.recipient_tenant=$2
            OR EXISTS (
              SELECT 1 FROM memberships source_member
              JOIN tenants source_tenant ON source_tenant.id=source_member.tenant_id
              JOIN rooms source_room
                ON source_room.id=source_member.room_id AND source_room.tenant_id=source_member.tenant_id
              WHERE m.tenant_id=$2 AND source_member.tenant_id=$2
                AND source_member.room_id=m.room_id AND source_member.alias=$3 AND source_member.enabled
                AND source_tenant.enabled AND source_room.enabled
            )
            OR EXISTS (
              SELECT 1 FROM acl_edges edge
              JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
              JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
              WHERE edge.from_tenant=$2 AND edge.to_tenant=d.recipient_tenant
                AND edge.enabled AND edge.allow_control
                AND source_tenant.enabled AND target_tenant.enabled
                AND (source_tenant.is_hub OR target_tenant.is_hub)
            )
          )
         FOR UPDATE OF d,m,dl`,
        [deliveryId, actorTenant, actorAlias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'terminal delivery not found or not visible');
      await this.assertReplayAuthorization(client, actorTenant, actorAlias, row);

      const existingReplay = await client.query(
        `SELECT 1
         FROM audit_events replay
         JOIN deliveries replayed_delivery ON replayed_delivery.id=replay.delivery_id
         JOIN messages replayed_message ON replayed_message.id=replay.message_id
         WHERE replay.action='delivery.replay' AND replay.decision='allow'
           AND replay.metadata->>'replayed_from_delivery_id'=$1
           AND replayed_delivery.message_id=replayed_message.id
         LIMIT 1`,
        [row.id]
      );
      if (existingReplay.rowCount) {
        throw new StoreError('conflict', 'delivery already has a durable replay clone');
      }

      const legacyReplay = row.dead_letter_resolved_at === null
        ? false
        : (await client.query(
          `SELECT 1 FROM adapter_outbox legacy
           WHERE legacy.tenant_id=$1 AND legacy.adapter='gateway' AND legacy.kind='wake'
             AND legacy.delivery_id=$2 AND legacy.message_id=$3 AND legacy.request_id=$4
             AND legacy.idempotency_key LIKE $5
             AND legacy.payload->>'recipient_alias'=$6
           LIMIT 1`,
          [
            row.recipient_tenant, row.id, row.message_id, row.request_id,
            `wake-replay:${row.id}:%`, row.recipient_alias
          ]
        )).rowCount === 1;
      if (row.dead_letter_resolved_at !== null && !legacyReplay) {
        throw new StoreError('not_found', 'terminal delivery has no open or legacy-replay dead letter');
      }

      const message = await client.query<{ id: string; request_id: string }>(
        `INSERT INTO messages(
           request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
           auth_session_id,auth_channel
         )
         SELECT gen_random_uuid(),trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                auth_session_id,auth_channel
         FROM messages WHERE id=$1
         RETURNING id,request_id`,
        [row.message_id]
      );
      const replayedMessage = message.rows[0];
      if (!replayedMessage) throw new Error('replay message insert returned no id');

      const delivery = await client.query<{ id: string }>(
        `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,max_attempts)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [replayedMessage.id, row.recipient_tenant, row.recipient_alias, row.max_attempts]
      );
      const replayedDeliveryId = delivery.rows[0]?.id;
      if (!replayedDeliveryId) throw new Error('replay delivery insert returned no id');

      if (row.dead_letter_resolved_at === null) {
        const resolved = await client.query(
          `UPDATE dead_letters SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL`,
          [row.dead_letter_id]
        );
        if (resolved.rowCount !== 1) {
          throw new StoreError('conflict', 'dead letter was already resolved');
        }
      }

      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         )
         SELECT $1,'gateway','wake',$2,replayed.request_id,replayed.id,$3,replayed.trace_id,replayed.origin,
                jsonb_build_object('recipient_alias',$4::text,'reason','delivery_available')
         FROM messages replayed WHERE replayed.id=$5`,
        [
          row.recipient_tenant, `wake-replay:${replayedDeliveryId}`, replayedDeliveryId,
          row.recipient_alias, replayedMessage.id
        ]
      );
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'delivery.replay','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          actorTenant, actorAlias, replayedMessage.request_id, replayedMessage.id, replayedDeliveryId, row.trace_id,
          JSON.stringify({
            replayed_from_delivery_id: row.id,
            replayed_from_message_id: row.message_id,
            legacy_dead_letter_recovery: legacyReplay,
            recipient_tenant: row.recipient_tenant,
            recipient_alias: row.recipient_alias
          })
        ]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake',
        JSON.stringify({ tenant_id: row.recipient_tenant, alias: row.recipient_alias })
      ]);
      return {
        delivery_id: replayedDeliveryId,
        replayed_from_delivery_id: row.id,
        state: 'pending',
        replayed: true
      };
    });
  }





  async listOriginRelays(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT outbox.id,outbox.tenant_id,outbox.adapter,outbox.request_id,outbox.message_id,
              outbox.delivery_id,outbox.trace_id,outbox.origin,outbox.payload,outbox.status,
              outbox.attempts,outbox.created_at,outbox.sent_at,message.actor_alias,
              message.tenant_id AS message_tenant_id,delivery.recipient_tenant,delivery.recipient_alias
       FROM adapter_outbox outbox JOIN messages message ON message.id=outbox.message_id
       LEFT JOIN deliveries delivery ON delivery.id=outbox.delivery_id
       WHERE outbox.kind='origin_relay' AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$1 AND source_member.room_id=message.room_id
                   AND source_member.alias=$2 AND source_member.enabled AND message.tenant_id=$1)
         OR (EXISTS (SELECT 1 FROM deliveries participant
                     WHERE participant.id=outbox.delivery_id AND participant.recipient_tenant=$1
                       AND participant.recipient_alias=$2)
             AND (message.tenant_id=$1 OR EXISTS (
               SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1
                 AND edge.to_tenant=message.tenant_id AND edge.enabled AND edge.allow_read
             )))
       ) ORDER BY outbox.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    return { items: result.rows };
  }
}
