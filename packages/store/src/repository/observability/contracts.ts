import type { DeliveryState, Origin, Tenant } from '@cauce/protocol';
import { DISABLED_DELEGATION_CAPS, type DelegationCaps } from '../../delegation-guard.js';

export interface DeliveryRow {
  id: string;
  message_id: string;
  recipient_tenant: Tenant;
  recipient_alias: string;
  status: DeliveryState;
  attempt: number;
  max_attempts: number;
  last_ack_rank: number;
  request_id: string;
  trace_id: string;
  tenant_id: Tenant;
  room_id: string;
  actor_alias: string;
  body: Record<string, unknown>;
  lane: 'interactive' | 'batch';
  priority: number;
  origin: Origin | null;
  auth_session_id: string | null;
  auth_channel: string | null;
  consumer_instance_id: string | null;
  consumer_epoch: string | null;
  claim_token: string | null;
  ack_deadline_at: Date | null;
}

/** Qué pasó con el aviso al origen cuando se rescató un resultado tardío. */
export type LateRelayDisposition = 'skipped' | 'inserted' | 'rewritten' | 'corrected';

/** Privacy-bounded operational DLQ row.  No message, delivery, outbox or provider id is exposed. */
export interface OperationalDlqItem {
  readonly target: 'delivery' | 'outbox';
  readonly id: string;
  readonly tenantId: Tenant;
  readonly kind: string;
  readonly adapter: string | null;
  readonly disposition: 'ambiguous' | 'safe_retry' | 'missing_final' | 'auth'
    | 'expected_offline' | 'unclassified';
  readonly open: boolean;
  readonly actionable: boolean;
  readonly evidenceSha256: string | null;
  readonly attempts: number;
  readonly resolutionRule: string | null;
  readonly createdAt: string;
  readonly dispositionAt: string | null;
  readonly resolvedAt: string | null;
  readonly reopenCount: number;
  readonly lastReopenedAt: string | null;
}

/** One deterministic keyset page.  `nextCursor` is opaque and bound to the actor scope in SQL. */
export interface OperationalDlqPage {
  readonly schemaVersion: 1;
  readonly items: OperationalDlqItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface OperationalDlqResolutionRequest {
  readonly target: 'delivery' | 'outbox';
  readonly id: string;
  readonly evidenceSha256: string;
  readonly reason: string;
  readonly possibleDuplicateAcknowledged: boolean;
  readonly possibleNoDeliveryAcknowledged: boolean;
}

export interface OperationalDlqResolutionResult {
  readonly schemaVersion: 1;
  readonly suite: 'cauce-v3-dlq-no-replay-resolution';
  readonly phase: 'resolved';
  readonly appliedCount: number;
  readonly alreadyApplied: boolean;
  readonly evidenceSha256: string;
  readonly reasonSha256: string;
  readonly possibleDuplicateAcknowledged: boolean;
  readonly possibleNoDeliveryAcknowledged: boolean;
}

export interface ChainPolicy {
  progressRelayEnabled: boolean;
  progressRelayMaxEvents: number;
  cycleCutEnabled: boolean;
  /** False until migration 008 lands, which keeps ACKs working during a partial deploy. */
  visitedPathAvailable: boolean;
  failureCoalesceEnabled: boolean;
  failureCoalesceWindowSeconds: number;
  /** False until migration 014 lands; same partial-deploy contract as visitedPathAvailable. */
  failureCoalesceAvailable: boolean;
  /** Topes de disciplina de delegación (019). `enabled:false` = conducta previa a 019. */
  delegationCaps: DelegationCaps;
  /** False until migration 019 lands; same partial-deploy contract as visitedPathAvailable. */
  delegationCapsAvailable: boolean;
  humanGateEnabled: boolean;
  /** False until migration 019 lands: sin la tabla no hay gates y `@human` vuelve a ser unroutable. */
  humanGateAvailable: boolean;
}

export const disabledChainPolicy: ChainPolicy = {
  progressRelayEnabled: false,
  progressRelayMaxEvents: 0,
  cycleCutEnabled: false,
  visitedPathAvailable: false,
  failureCoalesceEnabled: false,
  failureCoalesceWindowSeconds: 0,
  failureCoalesceAvailable: false,
  delegationCaps: DISABLED_DELEGATION_CAPS,
  delegationCapsAvailable: false,
  humanGateEnabled: false,
  humanGateAvailable: false
};

/**
 * 'coalesced' es un retorno LEGÍTIMO, no un error: el fracaso quedó registrado y el padre ya
 * había sido avisado de esta misma causa dentro de la ventana. Se distingue de 'not_child'
 * porque sigue siendo una rama con padre, y de 'returned' porque no produjo entrega. Los dos
 * consumidores de este tipo sólo preguntan por 'not_child' (para decidir el relay al origen),
 * así que un fracaso plegado nunca se escapa hacia Telegram como si nadie lo estuviera esperando.
 */
export type AgentResponseDisposition = 'not_child' | 'returned' | 'denied' | 'deferred' | 'coalesced';

export interface AgentFaninDisposition {
  hasFanout: boolean;
  scheduled: boolean;
}

/** Migration 016_chain_silence_sweep constrains agent_chain_closures.reason to exactly these values. */
export type ChainSilenceClosureReason = 'settled_without_fanin' | 'idle_timeout';

export interface ChainSilenceSweepOptions {
  /** Sin avance durante este plazo Y con trabajo abierto todavía: se cierra por vencimiento. */
  idleMs?: number;
  /** Cadena ya quieta (nada puede volver a moverla): gracia corta antes de cerrar. */
  settledGraceMs?: number;
  /** Ventana de rastreo. Una raíz más vieja que esto ya no se avisa nunca. */
  maxAgeMs?: number;
  /** Techo duro de raíces tocadas por barrido. */
  limit?: number;
}

export interface ChainSilenceSweepResult {
  /** Raíces candidatas leídas en este barrido. */
  scanned: number;
  /** Raíces destrabadas: el fan-in real quedó agendado y el humano recibirá la síntesis. */
  faninRecovered: number;
  /** Raíces cerradas con un aviso agregado al origen. Nunca más de una por raíz. */
  notified: number;
  /** Raíces salteadas (otro proceso las tenía tomadas, o su cierre falló y se reintentará). */
  skipped: number;
}
