import type { DeliveryState, Origin, Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import type {
  ChainSilenceClosureReason, ChainSilenceSweepOptions, ChainSilenceSweepResult
} from './contracts.js';
import { aliasPattern, originRelayTenant, truncateUtf8 } from './helpers.js';
import { ObservabilityMaintenanceRepository } from './maintenance.js';

const chainSilenceIdleMs = 6 * 60 * 60 * 1_000;

const chainSilenceSettledGraceMs = 15 * 60 * 1_000;

const chainSilenceMaxAgeMs = 48 * 60 * 60 * 1_000;

const chainSilenceSweepLimit = 5;

const chainSilenceNoticeMaxBytes = 1_024;

const chainSilenceCauseMaxBytes = 240;

interface ChainSilenceCandidate {
  root_message_id: string;
  tenant_id: Tenant;
  request_id: string;
  trace_id: string;
  origin: Origin;
  root_delivery_id: string | null;
  root_status: DeliveryState | null;
  root_attempt: number | null;
  root_max_attempts: number | null;
  branches: number;
  branches_dead: number;
  branches_failed: number;
  branches_open: number;
  open_work: number;
  fanin_present: boolean;
  idle_seconds: number;
}

/** "6 h 12 min", "18 min", "45 s". No libraries and no ambiguity for whoever reads it. */
function humanDuration(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  if (total < 60) return `${String(total)} s`;
  const minutes = Math.trunc(total / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.trunc(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) {
    return rest === 0
      ? `${String(hours)} h`
      : `${String(hours)} h ${String(rest)} min`;
  }
  return `${String(Math.trunc(hours / 24))} d ${String(hours % 24)} h`;
}

/**
 * The aggregated notice: ONE line with the count by outcome and the dominant cause; never the enumeration of branches.
 * Deliberately it does NOT include the text of any branch: pasting agent output without the coordinator's synthesis
 * turns the notice into long noise, pushes untrusted text into the owner's chat; the root's id is the only handle left.
 */
function chainSilenceNoticeText(
  candidate: ChainSilenceCandidate,
  detail: { answered: number; cause?: string; causeCount: number },
  reason: ChainSilenceClosureReason
): string {
  const idle = humanDuration(candidate.idle_seconds);
  const head = candidate.branches === 0
    ? `⚠️ Tu pedido quedó sin respuesta: nadie llegó a trabajarlo`
      + `${candidate.root_status === null ? '' : ` (entrega en «${candidate.root_status}»`
        + `${candidate.root_attempt === null ? '' : `, ${String(candidate.root_attempt)}/${String(candidate.root_max_attempts ?? '?')} intentos`})`}.`
    : `⚠️ Tu pedido quedó sin respuesta: de ${String(candidate.branches)} `
      + `${candidate.branches === 1 ? 'rama delegada' : 'ramas delegadas'}, ${String(detail.answered)} `
      + `${detail.answered === 1 ? 'devolvió' : 'devolvieron'} resultado, ${String(candidate.branches_dead)} `
      + `${candidate.branches_dead === 1 ? 'murió' : 'murieron'}, ${String(candidate.branches_failed)} `
      + `${candidate.branches_failed === 1 ? 'falló' : 'fallaron'} y ${String(candidate.branches_open)} `
      + `${candidate.branches_open === 1 ? 'sigue' : 'siguen'} sin terminar.`;
  const why = detail.cause === undefined
    ? ''
    : ` Causa dominante: «${detail.cause}» (${String(detail.causeCount)}).`;
  const tail = reason === 'settled_without_fanin'
    ? ` La cadena se apagó hace ${idle} y ya no puede avanzar sola, así que la cierro acá.`
    : ` Sin ningún avance desde hace ${idle}, así que la cierro acá.`;
  return truncateUtf8(
    `${head}${why}${tail} (raíz ${candidate.root_message_id})`,
    chainSilenceNoticeMaxBytes
  ).value;
}

/**
 * Third-party text (the `last_error` an agent wrote) going to a human chat: control chars stripped,
 * bounded like `agentResponseText`; data, not instruction and not format.
 */
function sanitizedDiagnostic(value: string): string {
  return value.replace(/[\p{Cf}\p{Cc}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function originBridgeAlias(origin: Origin): string {
  const alias = origin.metadata.bridge_alias;
  return typeof alias === 'string' && aliasPattern.test(alias) ? alias : origin.adapter;
}

export abstract class ObservabilityChainSweepRepository extends ObservabilityMaintenanceRepository {

  /**
   * Periodic sweep of idle or silent chains to ensure every task completes its fan-in or
   * emits a consolidated closing reply toward the origin.
   */
  async sweepSilentChains(options: ChainSilenceSweepOptions = {}): Promise<ChainSilenceSweepResult> {
    const idleMs = Math.max(1_000, Math.trunc(options.idleMs ?? chainSilenceIdleMs));
    const settledGraceMs = Math.max(1_000, Math.trunc(options.settledGraceMs ?? chainSilenceSettledGraceMs));
    const maxAgeMs = Math.max(idleMs, Math.trunc(options.maxAgeMs ?? chainSilenceMaxAgeMs));
    const limit = Math.max(1, Math.min(50, Math.trunc(options.limit ?? chainSilenceSweepLimit)));
    const result: ChainSilenceSweepResult = { scanned: 0, faninRecovered: 0, notified: 0, skipped: 0 };
    const candidates = await this.pool.query<ChainSilenceCandidate>(
      `WITH candidate AS (
         SELECT root.id AS root_message_id,root.tenant_id,root.request_id,root.trace_id,root.origin,
                root.created_at,
                first_delivery.id AS root_delivery_id,first_delivery.status AS root_status,
                first_delivery.attempt AS root_attempt,first_delivery.max_attempts AS root_max_attempts,
                COALESCE(chain.branches,0)::int AS branches,
                COALESCE(chain.branches_dead,0)::int AS branches_dead,
                COALESCE(chain.branches_failed,0)::int AS branches_failed,
                COALESCE(chain.branches_open,0)::int AS branches_open,
                (COALESCE(chain.branches_open,0)
                 + COALESCE(own.open_deliveries,0)
                 + COALESCE(continuation.open_deliveries,0))::int AS open_work,
                COALESCE(continuation.fanin_present,false) AS fanin_present,
                GREATEST(
                  root.created_at,
                  COALESCE(own.last_event,root.created_at),
                  COALESCE(chain.last_event,root.created_at),
                  COALESCE(continuation.last_event,root.created_at)
                ) AS last_event
         FROM messages root
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE own_delivery.status NOT IN ('done','failed','dead')) AS open_deliveries,
                  max(GREATEST(own_delivery.updated_at,own_delivery.created_at)) AS last_event
           FROM deliveries own_delivery WHERE own_delivery.message_id=root.id
         ) own ON true
         LEFT JOIN LATERAL (
           SELECT own_delivery.id,own_delivery.status,own_delivery.attempt,own_delivery.max_attempts
           FROM deliveries own_delivery WHERE own_delivery.message_id=root.id
           ORDER BY own_delivery.created_at,own_delivery.id LIMIT 1
         ) first_delivery ON true
         LEFT JOIN LATERAL (
           SELECT count(*) AS branches,
                  count(*) FILTER (WHERE child.status='dead') AS branches_dead,
                  count(*) FILTER (WHERE child.status='failed') AS branches_failed,
                  count(*) FILTER (WHERE child.status NOT IN ('done','failed','dead')) AS branches_open,
                  max(GREATEST(child.updated_at,child.created_at,materialization.created_at)) AS last_event
           FROM agent_output_materializations materialization
           JOIN deliveries child ON child.id=materialization.produced_delivery_id
           WHERE materialization.status='materialized'
             AND materialization.correlation->>'root_message_id'=root.id::text
         ) chain ON true
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (
                    WHERE continuation_delivery.status NOT IN ('done','failed','dead')
                  ) AS open_deliveries,
                  (count(*) FILTER (WHERE continuation.body->>'type'='agent.fanin') > 0) AS fanin_present,
                  max(GREATEST(
                    continuation_delivery.updated_at,continuation_delivery.created_at,continuation.created_at
                  )) AS last_event
           FROM messages continuation
           JOIN deliveries continuation_delivery ON continuation_delivery.message_id=continuation.id
           WHERE continuation.body->'correlation'->>'root_message_id'=root.id::text
             AND continuation.body->>'type' IN ('agent.response','agent.fanin')
         ) continuation ON true
         WHERE root.origin IS NOT NULL
           AND root.origin->>'adapter' IS NOT NULL
           AND root.created_at > now()-($3::bigint*interval '1 millisecond')
           AND root.created_at <= now()-(LEAST($1::bigint,$2::bigint)*interval '1 millisecond')
           AND COALESCE(root.body->>'type','') NOT IN ('agent.message','agent.response','agent.fanin','agent.notify')
           AND NOT EXISTS (
             SELECT 1 FROM agent_output_materializations produced
             WHERE produced.produced_message_id=root.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_chain_closures closure WHERE closure.root_message_id=root.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM adapter_outbox relay
             WHERE relay.kind='origin_relay'
               AND relay.payload->>'relay_kind' IS DISTINCT FROM 'ack'
               AND COALESCE(
                 relay.payload#>>'{correlation,root_message_id}',
                 relay.payload#>>'{correlation,message_id}'
               )=root.id::text
           )
       )
       SELECT root_message_id,tenant_id,request_id,trace_id,origin,
              root_delivery_id,root_status,root_attempt,root_max_attempts,
              branches,branches_dead,branches_failed,branches_open,
              open_work,fanin_present,
              GREATEST(0,extract(epoch FROM now()-last_event))::int AS idle_seconds
       FROM candidate
       WHERE (open_work=0 AND last_event <= now()-($2::bigint*interval '1 millisecond'))
          OR (open_work>0 AND last_event <= now()-($1::bigint*interval '1 millisecond'))
       ORDER BY last_event
       LIMIT $4`,
      [idleMs, settledGraceMs, maxAgeMs, limit]
    );
    result.scanned = candidates.rows.length;
    for (const candidate of candidates.rows) {
      try {
        // One transaction per root prevents an invalid candidate from canceling the whole sweep.
        const outcome = await withTransaction(this.pool, (client) => this.closeSilentChain(client, candidate));
        if (outcome === 'fanin') result.faninRecovered += 1;
        else if (outcome === 'notified') result.notified += 1;
        else result.skipped += 1;
      } catch (error) {
        result.skipped += 1;
        console.error(JSON.stringify({
          event: 'chain_silence_sweep_failed',
          root_message_id: candidate.root_message_id,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }
    return result;
  }

  /** A watcher candidate, under lock and in its own transaction. */
  private async closeSilentChain(
    client: DatabaseClient,
    candidate: ChainSilenceCandidate
  ): Promise<'fanin' | 'notified' | 'skipped'> {
    // The same lock `materializeAgentFanin` takes, so the ACK in flight and the watcher never
    // step on each other. `try` and non-blocking: another process holding it means the root is
    // skipped and returns next sweep, no connection held.
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired`,
      [`agent-fanin:${candidate.root_message_id}`]
    );
    if (lock.rows[0]?.acquired !== true) return 'skipped';

    // Re-read under lock: between the candidate query and this transaction the chain could have
    // closed on its own, and that real closure always wins over the watcher's notice.
    const state = await client.query<{ closed: boolean; relayed: boolean }>(
      `SELECT EXISTS(
                SELECT 1 FROM agent_chain_closures closure WHERE closure.root_message_id=$1::uuid
              ) AS closed,
              EXISTS(
                SELECT 1 FROM adapter_outbox relay
                WHERE relay.kind='origin_relay'
                  AND relay.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                  AND COALESCE(
                    relay.payload#>>'{correlation,root_message_id}',
                    relay.payload#>>'{correlation,message_id}'
                  )=$1::text
              ) AS relayed`,
      [candidate.root_message_id]
    );
    if (state.rows[0]?.closed === true || state.rows[0]?.relayed === true) return 'skipped';

    // 1. Real unblock. A fan-in that can now be scheduled gives the human the coordinator's
    //    synthesis instead of a failure diagnostic.
    if (candidate.branches > 0 && !candidate.fanin_present) {
      await client.query('SAVEPOINT chain_silence_fanin');
      try {
        // A branch that reached a terminal state WITHOUT going through the ACK does not have its
        // `agent_output.response` row and is therefore UNCOUNTABLE for the fan-in: see
        // `recordTerminalBranchesWithoutResponse`. It is filled only here and only with the
        // chain already declared silent and with no open work.
        if (candidate.open_work === 0) {
          await this.recordTerminalBranchesWithoutResponse(client, candidate.root_message_id);
        }
        const fanin = await this.materializeAgentFanin(client, candidate.root_message_id);
        if (fanin.scheduled) {
          await client.query('RELEASE SAVEPOINT chain_silence_fanin');
          await this.recordChainSweepAudit(client, candidate, 'fanin_recovered', undefined, undefined);
          return 'fanin';
        }
        // It was not unblocked: the synthetic rows are discarded. If they remained,
        // `chainSilenceDetail` would count them as branches that returned a result and the
        // notice to the human would say that N branches answered when none did. Either it
        // unblocks or it leaves no trace.
        await client.query('ROLLBACK TO SAVEPOINT chain_silence_fanin');
      } catch (error) {
        // An SQL failure here poisons the transaction; the savepoint returns it intact so the
        // root still ends up with a notice instead of being silent once more.
        await client.query('ROLLBACK TO SAVEPOINT chain_silence_fanin');
        console.error(JSON.stringify({
          event: 'chain_silence_fanin_failed',
          root_message_id: candidate.root_message_id,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    }

    // 2. Closure with aggregated notice.
    const detail = await this.chainSilenceDetail(client, candidate.root_message_id);
    const reason: ChainSilenceClosureReason = candidate.open_work === 0
      ? 'settled_without_fanin'
      : 'idle_timeout';
    const text = chainSilenceNoticeText(candidate, detail, reason);
    const relay = await client.query<{ id: string }>(
      `INSERT INTO adapter_outbox(
         tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
       ) VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
       ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING
       RETURNING id`,
      [
        originRelayTenant({ tenant_id: candidate.tenant_id, origin: candidate.origin }),
        candidate.origin.adapter,
        `relay-chain-closure:${candidate.root_message_id}`,
        candidate.request_id,
        candidate.root_message_id,
        candidate.root_delivery_id,
        candidate.trace_id,
        JSON.stringify(candidate.origin),
        JSON.stringify({
          outcome: 'failed',
          error: text,
          error_code: 'CHAIN_CLOSED_WITHOUT_ANSWER',
          result: {
            output: { reply: text, messages: [], status: 'failed', retryable: false, artifacts: [] }
          },
          chain_closure: {
            schema: 'cauce.chain_closure.v1',
            reason,
            branches: candidate.branches,
            branches_answered: detail.answered,
            branches_dead: candidate.branches_dead,
            branches_failed: candidate.branches_failed,
            branches_open: candidate.branches_open,
            open_work: candidate.open_work,
            idle_seconds: candidate.idle_seconds,
            ...(detail.cause === undefined
              ? {}
              : { dominant_cause: detail.cause, dominant_cause_count: detail.causeCount })
          },
          correlation: {
            request_id: candidate.request_id,
            message_id: candidate.root_message_id,
            root_message_id: candidate.root_message_id,
            trace_id: candidate.trace_id,
            ...(candidate.root_delivery_id === null ? {} : { delivery_id: candidate.root_delivery_id })
          }
        })
      ]
    );
    // The durable anchor of "one notice per root, forever". It survives the outbox purge and
    // is what removes the root from the candidate set in the next sweep.
    const closure = await client.query(
      `INSERT INTO agent_chain_closures(
         root_message_id,tenant_id,adapter,reason,branches,branches_answered,branches_dead,
         branches_open,dominant_cause,dominant_cause_count,idle_seconds,outbox_id
       ) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(root_message_id) DO NOTHING`,
      [
        candidate.root_message_id,
        originRelayTenant({ tenant_id: candidate.tenant_id, origin: candidate.origin }),
        candidate.origin.adapter,
        reason,
        candidate.branches,
        detail.answered,
        candidate.branches_dead,
        candidate.branches_open,
        detail.cause ?? null,
        detail.causeCount,
        candidate.idle_seconds,
        relay.rows[0]?.id ?? null
      ]
    );
    if (!closure.rowCount) return 'skipped';
    await this.recordChainSweepAudit(client, candidate, 'closed', reason, detail);
    // Without `pg_notify`: the `cauce_delivery_wake` channel wakes up delivery consumers by
    // agent alias, and this does not create any delivery. The bridge picks up the relay
    // through `claimOutbox`, which is the usual durable path.
    return 'notified';
  }

  /**
   * Records audit events for branches in a terminal state that lack a recorded reply,
   * allowing the fan-in count in idle chains to be unblocked.
   */
  private async recordTerminalBranchesWithoutResponse(
    client: DatabaseClient,
    rootMessageId: string
  ): Promise<number> {
    const answered = await client.query<{ answered: boolean }>(
      `SELECT EXISTS(
                SELECT 1
                FROM agent_output_materializations materialization
                JOIN deliveries child ON child.id=materialization.produced_delivery_id
                WHERE materialization.status='materialized'
                  AND materialization.correlation->>'root_message_id'=$1
                  AND EXISTS (
                    SELECT 1 FROM audit_events response_audit
                    WHERE response_audit.action='agent_output.response'
                      AND response_audit.decision IN ('allow','deny')
                      AND response_audit.metadata->>'child_delivery_id'=child.id::text
                  )
              ) AS answered`,
      [rootMessageId]
    );
    const chainAnswered = answered.rows[0]?.answered === true;
    const filled = await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       )
       SELECT child.recipient_tenant,child.recipient_alias,
              'agent_output.response','deny',
              child_message.request_id,child.message_id,child.id,child_message.trace_id,
              jsonb_build_object(
                'reason','terminal_without_response',
                'child_delivery_id',child.id::text,
                'source_delivery_id',materialization.source_delivery_id::text,
                'target_tenant',materialization.source_tenant,
                'target_alias',materialization.source_alias,
                'outcome',child.status,
                'root_message_id',$1::text,
                'synthesized_by','chain_silence_sweep'
              )
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       JOIN messages child_message ON child_message.id=child.message_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1
         AND child.status IN ('done','failed','dead')
         AND (child.status='done' OR $2::boolean)
         AND NOT EXISTS (
           SELECT 1 FROM agent_output_materializations descendant
           WHERE descendant.source_delivery_id=child.id
             AND descendant.status='materialized'
         )
         AND NOT EXISTS (
           SELECT 1 FROM audit_events response_audit
           WHERE response_audit.action='agent_output.response'
             AND response_audit.decision IN ('allow','deny')
             AND response_audit.metadata->>'child_delivery_id'=child.id::text
         )`,
      [rootMessageId, chainAnswered]
    );
    return filled.rowCount ?? 0;
  }

  /**
   * Detail only computed for a root that will actually be noticed (rare), never in the candidate query:
   * the dominant cause and the count of branches that did reply.
   * The search by `metadata->>'child_delivery_id'` has no index and is what the fan-in already pays,
   * so it cannot run for every candidate in every sweep.
   */
  private async chainSilenceDetail(
    client: DatabaseClient,
    rootMessageId: string
  ): Promise<{ answered: number; cause?: string; causeCount: number }> {
    const answered = await client.query<{ answered: number | string }>(
      `SELECT count(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM audit_events answer
                  WHERE answer.action='agent_output.response'
                    AND answer.decision IN ('allow','deny')
                    AND answer.metadata->>'child_delivery_id'=child.id::text
                )
              )::int AS answered
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1`,
      [rootMessageId]
    );
    const cause = await client.query<{ cause: string; total: number | string }>(
      `SELECT COALESCE(NULLIF(btrim(child.last_error),''),child.status) AS cause,count(*)::int AS total
       FROM agent_output_materializations materialization
       JOIN deliveries child ON child.id=materialization.produced_delivery_id
       WHERE materialization.status='materialized'
         AND materialization.correlation->>'root_message_id'=$1
         AND child.status IN ('dead','failed')
       GROUP BY 1
       ORDER BY total DESC,cause
       LIMIT 1`,
      [rootMessageId]
    );
    const dominant = cause.rows[0];
    return {
      answered: Number(answered.rows[0]?.answered ?? 0),
      ...(dominant === undefined
        ? {}
        : { cause: truncateUtf8(sanitizedDiagnostic(dominant.cause), chainSilenceCauseMaxBytes).value }),
      causeCount: Number(dominant?.total ?? 0)
    };
  }

  private async recordChainSweepAudit(
    client: DatabaseClient,
    candidate: ChainSilenceCandidate,
    action: 'fanin_recovered' | 'closed',
    reason: ChainSilenceClosureReason | undefined,
    detail?: { answered: number; cause?: string; causeCount: number }
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'agent_chain.silence_sweep','info',$3,$4,$5,$6,$7::jsonb)`,
      [
        candidate.tenant_id,
        originBridgeAlias(candidate.origin),
        candidate.request_id,
        candidate.root_message_id,
        candidate.root_delivery_id,
        candidate.trace_id,
        JSON.stringify({
          outcome: action,
          ...(reason === undefined ? {} : { reason }),
          root_message_id: candidate.root_message_id,
          branches: candidate.branches,
          branches_dead: candidate.branches_dead,
          branches_failed: candidate.branches_failed,
          branches_open: candidate.branches_open,
          open_work: candidate.open_work,
          idle_seconds: candidate.idle_seconds,
          ...(detail === undefined
            ? {}
            : {
              branches_answered: detail.answered,
              ...(detail.cause === undefined
                ? {}
                : { dominant_cause: detail.cause, dominant_cause_count: detail.causeCount })
            })
        })
      ]
    );
  }

}
