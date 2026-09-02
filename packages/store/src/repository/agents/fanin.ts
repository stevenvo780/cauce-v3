import type { DeliveryState, Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/prefer-optional-chain: "error" */
import { StoreError } from '../errors.js';
import { terminal } from '../messages.js';
import {
  chainNode, opaqueNodeId
} from './fanin/helpers.js';
import { AgentFaninMaterializationRepository } from './fanin/materialization.js';

export {
  failureSignature, type AgentChainProgressStage
} from './fanin/helpers.js';
export { chainNode };

export abstract class AgentFaninRepository extends AgentFaninMaterializationRepository {
  /**
   * The detail that the aggregated notice promises. Without this method coalescing would be
   * losing information: the parent reads "N identical notices were folded, notice_id=X" and
   * with X it lands here —the raw cause of each of the N, with its delivery and its attempt.
   *
   * Default-deny as the rest of the read-models: only the parent the notice was addressed to,
   * the child that failed, or an operator of a hub tenant. A failure bucket names two tenants
   * (parent and child), so leaving it open would leak cross-tenant topology.
   */
  async failureNoticeDetail(
    noticeId: string,
    actorTenant: Tenant,
    actorAlias: string,
    limit = 500
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    if (!/^\d{1,19}$/u.test(noticeId)) throw new StoreError('not_found', 'failure notice id is invalid');
    const bounded = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 500, 1), 1_000);
    const notice = await this.pool.query<Record<string, unknown>>(
      `SELECT notice.id::text AS id,notice.root_message_id,notice.parent_tenant,notice.parent_alias,
              notice.child_tenant,notice.child_alias,notice.failure_signature,
              notice.window_started_at,notice.window_expires_at,notice.notices_emitted,
              notice.total_failures,
              (notice.total_failures-notice.notices_emitted) AS coalesced_failures,
              notice.last_notice_message_id,notice.created_at,notice.updated_at,
              (
                (notice.parent_tenant=$2 AND notice.parent_alias=$3)
                OR (notice.child_tenant=$2 AND notice.child_alias=$3)
                OR EXISTS (SELECT 1 FROM tenants hub WHERE hub.id=$2 AND hub.is_hub AND hub.enabled)
              ) AS visible
       FROM agent_failure_notices notice WHERE notice.id=$1::bigint`,
      [noticeId, actorTenant, actorAlias]
    );
    const row = notice.rows[0];
    // Absence and invisibility share one error to avoid a cross-tenant enumeration oracle.
    if (!row || row.visible !== true) throw new StoreError('not_found', 'failure notice was not found'); // eslint-disable-line @typescript-eslint/prefer-optional-chain -- Missing and invisible PostgreSQL rows share one response.
    const { visible: _visible, ...summary } = row;
    void _visible;
    const events = await this.pool.query<Record<string, unknown>>(
      `SELECT ack_delivery_id,ack_attempt,child_delivery_id,child_tenant,child_alias,outcome,
              error,error_code,coalesced,notice_message_id,created_at
       FROM agent_failure_notice_events
       WHERE notice_id=$1::bigint ORDER BY created_at,ack_delivery_id LIMIT $2`,
      [noticeId, bounded]
    );
    return { notice: summary, failures: events.rows };
  }

  /**
   * Live delegation topology of one trace: who delegated to whom, in what state each branch
   * is, and what actually reached the origin channel.
   *
   * Visibility is decided here, per node, and never by a caller-side facade: a chain is
   * intrinsically cross-tenant, so a same-tenant row filter would silently erase exactly the
   * edges this read-model exists to show, and a caller-side filter over a graph payload is
   * how cross-tenant leaks happen. A node is visible under the same default-deny rule as
   * getMessage (room membership inside the actor tenant, or participation plus an
   * allow_read ACL edge). An edge survives when at least one of its endpoints is visible;
   * the other endpoint is then reduced to an opaque, stable node id so the shape of the
   * chain stays readable without disclosing a foreign tenant, alias or delivery id.
   */
  async agentChain(
    traceId: string,
    actorTenant: Tenant,
    actorAlias: string,
    limit = 500
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    if (typeof traceId !== 'string' || traceId.length < 1 || traceId.length > 256) {
      throw new StoreError('not_found', 'trace id is invalid');
    }
    const bounded = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 500, 1), 1_000);
    const visible = (message: string): string => `(
      EXISTS (SELECT 1 FROM memberships member
              WHERE member.tenant_id=$2 AND member.room_id=${message}.room_id
                AND member.alias=$3 AND member.enabled AND ${message}.tenant_id=$2)
      OR (EXISTS (SELECT 1 FROM deliveries participant
                  WHERE participant.message_id=${message}.id
                    AND participant.recipient_tenant=$2 AND participant.recipient_alias=$3)
          AND (${message}.tenant_id=$2 OR EXISTS (
            SELECT 1 FROM acl_edges edge
            WHERE edge.from_tenant=$2 AND edge.to_tenant=${message}.tenant_id
              AND edge.enabled AND edge.allow_read)))
    )`;
    const [edges, branches, relays] = await Promise.all([
      this.pool.query<{
        source_delivery_id: string;
        source_attempt: number;
        output_index: number;
        source_tenant: Tenant;
        source_alias: string;
        target_tenant: Tenant | null;
        target_alias: string | null;
        produced_delivery_id: string | null;
        status: string;
        rejection_code: string | null;
        hop_count: number;
        hop_budget: number;
        visited_depth: number;
        root_message_id: string | null;
        created_at: Date;
        source_status: DeliveryState;
        target_status: DeliveryState | null;
        target_attempt: number | null;
        target_terminal_at: Date | null;
        source_visible: boolean;
        target_visible: boolean;
      }>(
        `SELECT materialization.source_delivery_id,materialization.source_attempt,
                materialization.output_index,materialization.source_tenant,
                materialization.source_alias,materialization.target_tenant,
                materialization.target_alias,materialization.produced_delivery_id,
                materialization.status,materialization.rejection_code,
                materialization.hop_count,materialization.hop_budget,
                coalesce(array_length(materialization.visited_path,1),0) AS visited_depth,
                materialization.correlation->>'root_message_id' AS root_message_id,
                materialization.created_at,
                source_delivery.status AS source_status,
                child.status AS target_status,child.attempt AS target_attempt,
                child.terminal_at AS target_terminal_at,
                ${visible('source_message')} AS source_visible,
                CASE WHEN produced_message.id IS NULL THEN false
                     ELSE ${visible('produced_message')} END AS target_visible
         FROM agent_output_materializations materialization
         JOIN messages source_message ON source_message.id=materialization.source_message_id
         JOIN deliveries source_delivery ON source_delivery.id=materialization.source_delivery_id
         LEFT JOIN deliveries child ON child.id=materialization.produced_delivery_id
         LEFT JOIN messages produced_message ON produced_message.id=materialization.produced_message_id
         WHERE materialization.trace_id=$1
         ORDER BY materialization.hop_count,materialization.created_at,materialization.output_index
         LIMIT $4`,
        [traceId, actorTenant, actorAlias, bounded]
      ),
      this.pool.query<{
        child_delivery_id: string | null;
        decision: string;
        reason: string | null;
        outcome: string | null;
      }>(
        `SELECT metadata->>'child_delivery_id' AS child_delivery_id,decision,
                metadata->>'reason' AS reason,metadata->>'outcome' AS outcome
         FROM audit_events
         WHERE trace_id=$1 AND action='agent_output.response' AND decision IN ('allow','deny')
         ORDER BY id LIMIT $2`,
        [traceId, bounded * 2]
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT outbox.id,outbox.tenant_id,outbox.adapter,outbox.status,outbox.attempts,
                outbox.created_at,outbox.sent_at,outbox.dead_at,
                outbox.payload->>'relay_kind' AS relay_kind,
                outbox.payload->>'progress_stage' AS progress_stage,
                outbox.payload->>'terminal'='true' AS interim,
                outbox.payload->>'outcome' AS outcome,
                outbox.payload->>'error_code' AS error_code,
                left(outbox.payload#>>'{result,output,reply}',500) AS reply
         FROM adapter_outbox outbox
         JOIN messages message ON message.id=outbox.message_id
         WHERE outbox.kind='origin_relay' AND outbox.trace_id=$1 AND ${visible('message')}
         ORDER BY outbox.created_at LIMIT $4`,
        [traceId, actorTenant, actorAlias, bounded]
      )
    ]);

    const branchByDelivery = new Map<string, { decision: string; reason: string | null; outcome: string | null }>();
    for (const branch of branches.rows) {
      if (branch.child_delivery_id && !branchByDelivery.has(branch.child_delivery_id)) {
        branchByDelivery.set(branch.child_delivery_id, {
          decision: branch.decision,
          reason: branch.reason,
          outcome: branch.outcome
        });
      }
    }
    const nodes = new Map<string, {
      tenant_id: Tenant; alias: string; hop_count: number;
      delegated: number; received: number; open_branches: number;
    }>();
    const upsertNode = (tenant: Tenant, alias: string, hopCount: number): {
      tenant_id: Tenant; alias: string; hop_count: number;
      delegated: number; received: number; open_branches: number;
    } => {
      const key = chainNode(tenant, alias);
      const existing = nodes.get(key);
      if (existing) {
        existing.hop_count = Math.min(existing.hop_count, hopCount);
        return existing;
      }
      const created = {
        tenant_id: tenant, alias, hop_count: hopCount,
        delegated: 0, received: 0, open_branches: 0
      };
      nodes.set(key, created);
      return created;
    };

    let redactedEndpoints = 0;
    const visibleEdges = edges.rows.filter((edge) => edge.source_visible || edge.target_visible);
    const renderedEdges = visibleEdges.map((edge) => {
      const branch = edge.produced_delivery_id
        ? branchByDelivery.get(edge.produced_delivery_id)
        : undefined;
      const open = edge.status === 'materialized'
        && edge.target_status !== null && !terminal(edge.target_status);
      if (edge.source_visible) {
        const node = upsertNode(edge.source_tenant, edge.source_alias, Math.max(0, edge.hop_count - 1));
        node.delegated += 1;
      } else {
        redactedEndpoints += 1;
      }
      if (edge.target_visible && edge.target_tenant && edge.target_alias) {
        const node = upsertNode(edge.target_tenant, edge.target_alias, edge.hop_count);
        node.received += 1;
        if (open) node.open_branches += 1;
      } else if (edge.status === 'materialized') {
        redactedEndpoints += 1;
      }
      return {
        source: edge.source_visible
          ? {
            tenant_id: edge.source_tenant,
            alias: edge.source_alias,
            delivery_id: edge.source_delivery_id,
            attempt: edge.source_attempt,
            status: edge.source_status
          }
          : { redacted: true, node_id: opaqueNodeId(edge.source_delivery_id) },
        target: edge.status !== 'materialized' || edge.produced_delivery_id === null
          ? null
          : edge.target_visible
            ? {
              tenant_id: edge.target_tenant,
              alias: edge.target_alias,
              delivery_id: edge.produced_delivery_id,
              attempt: edge.target_attempt,
              status: edge.target_status,
              terminal_at: edge.target_terminal_at
            }
            : { redacted: true, node_id: opaqueNodeId(edge.produced_delivery_id) },
        output_index: edge.output_index,
        state: edge.status,
        rejection_code: edge.rejection_code,
        hop_count: edge.hop_count,
        hop_budget: edge.hop_budget,
        visited_depth: edge.visited_depth,
        open,
        response: branch === undefined
          ? null
          : { decision: branch.decision, reason: branch.reason, outcome: branch.outcome },
        root_message_id: edge.source_visible ? edge.root_message_id : null,
        created_at: edge.created_at
      };
    });

    if (renderedEdges.length === 0 && relays.rows.length === 0) {
      throw new StoreError('not_found', 'agent chain not found or not visible');
    }
    return {
      trace_id: traceId,
      observed_at: new Date().toISOString(),
      truncated: edges.rows.length === bounded,
      nodes: [...nodes.values()].sort((left, right) =>
        left.hop_count - right.hop_count
        || chainNode(left.tenant_id, left.alias).localeCompare(chainNode(right.tenant_id, right.alias))),
      edges: renderedEdges,
      origin_relays: relays.rows,
      counters: {
        edges: renderedEdges.length,
        hidden_edges: edges.rows.length - renderedEdges.length,
        redacted_endpoints: redactedEndpoints,
        open_branches: renderedEdges.filter((edge) => edge.open).length,
        rejected_branches: renderedEdges.filter((edge) => edge.state === 'rejected').length
      }
    };
  }
}
