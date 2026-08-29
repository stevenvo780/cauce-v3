import {
  DelegationMaterializationSchema,
  DelegationRejectionSchema,
  MAX_DELEGATION_FEEDBACK_ITEMS,
  type Tenant
} from '@cauce/protocol';
import type { DatabaseClient } from '../../../db.js';
import {
  DISABLED_DELEGATION_CAPS,
  sanitizedDelegationCaps,
  type DelegationRejectionCode
} from '../../../delegation-guard.js';
import { AgentFaninRepository } from '../fanin.js';
import type {
  AckResult,
  AgentOutputEntry,
  DelegationMaterialization,
  DelegationRejection
} from '../../deliveries.js';
import { StoreError } from '../../errors.js';
import {
  aliasPattern,
  disabledChainPolicy,
  tenantPattern,
  type ChainPolicy
} from '../../observability.js';
import { objectRecord } from '../../outbox.js';
import { hashToUuidV7 } from '../../_hash-to-uuidv7.js';

const agentOutputHopBudget = 16;
export const maxAgentOutputExpandedBytes = 512 * 1024;
export const maxVisitedPathEntries = agentOutputHopBudget;
/** Matches the CHECK on `agent_chain_gates.question` (8192 characters). */
export const maxChainGateQuestionBytes = 8 * 1_024;

/**
 * The durable codes and their readable notices share delegation-guard.ts as their single source.
 */
export type AgentOutputRejectionCode = DelegationRejectionCode;

/**
 * A hop budget is only trusted when it is a safe positive integer, and it is always
 * saturated at the durable ceiling. A zero would violate CHECK (hop_budget > 0) and abort
 * the whole ACK transaction, and an inflated one would propagate hop after hop.
 */
export function safeHopBudget(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, agentOutputHopBudget)
    : agentOutputHopBudget;
}
/** Hop counts saturate at the budget, so `inherited + 1` can never overflow an integer column. */
export function safeHopCount(value: unknown, budget: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, budget)
    : 0;
}

/** Only canonical `tenant/alias` entries survive; the column is store-written, never client input. */
export function sanitizedVisitedPath(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const path: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || path.includes(entry)) continue;
    const separator = entry.indexOf('/');
    if (separator < 0) continue;
    const tenant = entry.slice(0, separator);
    const alias = entry.slice(separator + 1);
    if (!tenantPattern.test(tenant) || !aliasPattern.test(alias)) continue;
    path.push(entry);
    if (path.length === maxVisitedPathEntries) break;
  }
  return path;
}

export interface ResolvedAgentOutputEntry extends AgentOutputEntry {
  targetTenant?: Tenant;
  targetRef?: unknown;
}

export interface AgentOutputLineage {
  hop_count: number | null;
  hop_budget: number | null;
  correlation: Record<string, unknown> | null;
  visited_path: string[] | null;
}

export function agentOutputRequestId(deliveryId: string, attempt: number, outputIndex: number): string {
  return hashToUuidV7(`agent-output:${deliveryId}:${attempt}:${outputIndex}`);
}

export abstract class AgentChainPolicyRepository extends AgentFaninRepository {
  /**
   * Reads the versioned chain policy without ever aborting the caller's transaction.
   * A missing table or column is a legitimate state during a partial deploy, and a
   * `42P01`/`42703` inside the ACK transaction would poison every later statement, so the
   * catalog is probed first with a query that cannot fail.
   */
  protected async loadChainPolicy(client: DatabaseClient): Promise<ChainPolicy> {
    const schema = await client.query<{
      policies_present: boolean;
      visited_path_present: boolean;
      failure_coalesce_present: boolean;
      delegation_caps_present: boolean;
      human_gate_present: boolean;
    }>(
      `SELECT to_regclass('public.agent_chain_policies') IS NOT NULL AS policies_present,
              EXISTS (
                SELECT 1 FROM pg_attribute attribute
                WHERE attribute.attrelid=to_regclass('public.agent_output_materializations')
                  AND attribute.attname='visited_path' AND NOT attribute.attisdropped
              ) AS visited_path_present,
              (
                to_regclass('public.agent_failure_notices') IS NOT NULL
                AND to_regclass('public.agent_failure_notice_events') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_policies')
                    AND attribute.attname='failure_coalesce_enabled' AND NOT attribute.attisdropped
                )
              ) AS failure_coalesce_present,
              (
                to_regclass('public.agent_chain_edge_uses') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_policies')
                    AND attribute.attname='delegation_caps_enabled' AND NOT attribute.attisdropped
                )
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_progress')
                    AND attribute.attname='delegations' AND NOT attribute.attisdropped
                )
              ) AS delegation_caps_present,
              (
                to_regclass('public.agent_chain_gates') IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM pg_attribute attribute
                  WHERE attribute.attrelid=to_regclass('public.agent_chain_policies')
                    AND attribute.attname='human_gate_enabled' AND NOT attribute.attisdropped
                )
              ) AS human_gate_present`
    );
    const visitedPathAvailable = schema.rows[0]?.visited_path_present === true;
    // Coalescing requires both ledger tables and its policy columns; a partial schema
    // degrades without raising 42P01/42703 inside the ACK transaction.
    const failureCoalesceAvailable = schema.rows[0]?.failure_coalesce_present === true;
    // Delegation caps likewise require the edge ledger, progress fuel and policy columns;
    // a partial schema disables them without poisoning the ACK transaction.
    const delegationCapsAvailable = schema.rows[0]?.delegation_caps_present === true;
    const humanGateAvailable = schema.rows[0]?.human_gate_present === true;
    if (schema.rows[0]?.policies_present !== true) {
      return { ...disabledChainPolicy, visitedPathAvailable };
    }
    const policy = await client.query<{
      progress_relay_enabled: boolean;
      progress_relay_max_events: number;
      cycle_cut_enabled: boolean;
      failure_coalesce_enabled: boolean | null;
      failure_coalesce_window_seconds: number | null;
      delegation_caps_enabled: boolean | null;
      max_fanout_per_turn: number | null;
      max_edge_repeats_per_root: number | null;
      max_delegations_per_root: number | null;
      human_gate_enabled: boolean | null;
    }>(
      `SELECT progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
              ${failureCoalesceAvailable
                ? 'failure_coalesce_enabled,failure_coalesce_window_seconds'
                : 'NULL::boolean AS failure_coalesce_enabled,NULL::integer AS failure_coalesce_window_seconds'},
              ${delegationCapsAvailable
                ? 'delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,max_delegations_per_root'
                : `NULL::boolean AS delegation_caps_enabled,NULL::integer AS max_fanout_per_turn,
                   NULL::integer AS max_edge_repeats_per_root,NULL::integer AS max_delegations_per_root`},
              ${humanGateAvailable
                ? 'human_gate_enabled'
                : 'NULL::boolean AS human_gate_enabled'}
       FROM agent_chain_policies WHERE id='default'`
    );
    const row = policy.rows[0];
    if (!row) return { ...disabledChainPolicy, visitedPathAvailable };
    const windowSeconds = Number.isSafeInteger(row.failure_coalesce_window_seconds)
      ? Number(row.failure_coalesce_window_seconds)
      : 0;
    return {
      progressRelayEnabled: row.progress_relay_enabled === true,
      progressRelayMaxEvents: Number.isSafeInteger(row.progress_relay_max_events)
        ? row.progress_relay_max_events
        : 0,
      cycleCutEnabled: row.cycle_cut_enabled === true && visitedPathAvailable,
      visitedPathAvailable,
      failureCoalesceEnabled: failureCoalesceAvailable && row.failure_coalesce_enabled === true,
      // A saturated ceiling, never a raw value: the CHECK on the column is NOT VALID, so a row
      // written before it existed could still carry an absurd window and mute a parent for days.
      failureCoalesceWindowSeconds: Math.min(86_400, Math.max(0, windowSeconds)),
      failureCoalesceAvailable,
      delegationCaps: delegationCapsAvailable
        ? sanitizedDelegationCaps({
          enabled: row.delegation_caps_enabled === true,
          maxFanoutPerTurn: row.max_fanout_per_turn ?? undefined,
          maxEdgeRepeatsPerRoot: row.max_edge_repeats_per_root ?? undefined,
          maxDelegationsPerRoot: row.max_delegations_per_root ?? undefined
        })
        : DISABLED_DELEGATION_CAPS,
      delegationCapsAvailable,
      humanGateEnabled: humanGateAvailable && row.human_gate_enabled === true,
      humanGateAvailable
    };
  }

  /**
   * Rebuild the capability-gated receipt from durable materialization rows.
   *
   * This is used for an exact repeated event after the DB committed but the adapter died before
   * receiving ack_result. It returns the same ordered identities/notices as the fresh ACK and
   * never selects target_ref_hash, body_hash, messages or bodies.
   */
  protected override async delegationFeedbackForAck(
    client: DatabaseClient,
    deliveryId: string,
    attempt: number,
  ): Promise<Pick<AckResult, "delegation_rejections" | "delegation_materializations">> {
    const rows = await client.query<{
      output_index: number;
      status: 'materialized' | 'rejected';
      target_tenant: Tenant | null;
      target_alias: string | null;
      produced_delivery_id: string | null;
      rejection: unknown;
    }>(
      `SELECT output_index,status,target_tenant,target_alias,produced_delivery_id,
              correlation->'rejection' AS rejection
       FROM agent_output_materializations
       WHERE source_delivery_id=$1 AND source_attempt=$2
       ORDER BY output_index
       LIMIT $3`,
      [deliveryId, attempt, MAX_DELEGATION_FEEDBACK_ITEMS + 1],
    );
    if (rows.rows.length > MAX_DELEGATION_FEEDBACK_ITEMS) {
      throw new StoreError('conflict', 'durable delegation feedback exceeds the wire limit');
    }
    const delegationRejections: DelegationRejection[] = [];
    const delegationMaterializations: DelegationMaterialization[] = [];
    for (const row of rows.rows) {
      if (row.status === 'materialized') {
        delegationMaterializations.push(DelegationMaterializationSchema.parse({
          output_index: row.output_index,
          target_tenant: row.target_tenant,
          target_alias: row.target_alias,
          child_delivery_id: row.produced_delivery_id,
        }));
        continue;
      }
      const rejection = objectRecord(row.rejection);
      const parsed = DelegationRejectionSchema.safeParse({
        output_index: row.output_index,
        ...rejection,
      });
      // Rows written before readable rejection notices existed cannot reconstruct text exactly.
      // Omitting legacy feedback is safer than breaking every reconnect with an invalid frame.
      if (parsed.success) delegationRejections.push(parsed.data);
    }
    return {
      ...(delegationRejections.length === 0
        ? {}
        : { delegation_rejections: delegationRejections }),
      ...(delegationMaterializations.length === 0
        ? {}
        : { delegation_materializations: delegationMaterializations }),
    };
  }
}
