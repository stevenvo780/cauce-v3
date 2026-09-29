import { createHash } from 'node:crypto';
import { isRfcUuid, type DeliveryState, type Tenant } from '@cauce/protocol';
import { withTransaction } from '../db.js';
import { maxProgressSummaryBytes } from './agents/fanin/helpers.js';
import { insertProgressRelay } from './agents/fanin/progress.js';
import { StoreError } from './errors.js';
import type { DeliveryRow } from './observability.js';
import { QuotasRepository } from './quotas.js';

export interface AgentProgressInput {
  text: string;
  attempt: number;
  claim_token: string;
  epoch: number;
  instance_id: string;
}

export function parseAgentProgress(value: unknown): AgentProgressInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'progress must be an object');
  }
  const input = value as Record<string, unknown>;
  const keys = ['text', 'attempt', 'claim_token', 'epoch', 'instance_id'];
  if (Object.keys(input).some((key) => !keys.includes(key))
      || typeof input.text !== 'string' || input.text.trim().length === 0
      || input.text.includes('\0') || Buffer.byteLength(input.text) > maxProgressSummaryBytes
      || typeof input.attempt !== 'number' || !Number.isSafeInteger(input.attempt) || input.attempt < 1
      || typeof input.epoch !== 'number' || !Number.isSafeInteger(input.epoch) || input.epoch < 1
      || !isRfcUuid(input.claim_token)
      || typeof input.instance_id !== 'string' || input.instance_id.length < 1 || input.instance_id.length > 128) {
    throw new StoreError('invalid_input', 'progress requires text up to 1024 UTF-8 bytes and an exact delivery claim');
  }
  return {
    text: input.text, attempt: input.attempt, claim_token: input.claim_token,
    epoch: input.epoch, instance_id: input.instance_id,
  };
}

export abstract class AgentEmissionRepository extends QuotasRepository {
  async agentQueue(tenantId: Tenant, alias: string) {
    await this.assertPermission(tenantId, alias, 'read');
    const result = await this.pool.query<{
      delivery_id: string; status: DeliveryState; attempt: number;
      deadline_at: Date | null; created_at: Date; total: string;
    }>(
      `SELECT id AS delivery_id,status,attempt,ack_deadline_at AS deadline_at,created_at,
              count(*) OVER()::text AS total
       FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2
         AND status NOT IN ('done','failed','dead')
       ORDER BY created_at,id LIMIT 200`,
      [tenantId, alias],
    );
    return {
      deliveries: result.rows.map(({ total: _total, ...row }) => row),
      total: Number(result.rows[0]?.total ?? 0),
    };
  }

  async recordAgentProgress(deliveryId: string, tenantId: Tenant, alias: string, input: AgentProgressInput) {
    const progress = parseAgentProgress(input);
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const lease = await client.query<{ lease_until: Date }>(
        `SELECT lease_until FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
           AND epoch=$4 AND lease_until>clock_timestamp() FOR SHARE`,
        [tenantId, alias, progress.instance_id, progress.epoch],
      );
      const consumerLease = lease.rows[0];
      if (!consumerLease) throw new StoreError('fenced', 'progress requires a live consumer lease');
      const selected = await client.query<DeliveryRow>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3 FOR UPDATE OF d`,
        [deliveryId, tenantId, alias],
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found for consumer');
      const live = await client.query<{ valid: boolean }>(
        `SELECT $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp() AS valid`,
        [row.ack_deadline_at, consumerLease.lease_until],
      );
      if (live.rows[0]?.valid !== true || !['leased', 'accepted', 'started'].includes(row.status)
          || row.attempt !== progress.attempt || row.claim_token !== progress.claim_token
          || row.consumer_instance_id !== progress.instance_id || Number(row.consumer_epoch) !== progress.epoch) {
        throw new StoreError('fenced', 'progress rejected by delivery claim fencing');
      }
      const eventKey = createHash('sha256').update(progress.text).digest('hex');
      const existing = await client.query<{ id: string }>(
        `SELECT id::text FROM audit_events WHERE delivery_id=$1 AND action='delivery.progress'
           AND metadata->>'attempt'=$2 AND metadata->>'text_sha256'=$3 LIMIT 1`,
        [row.id, String(progress.attempt), eventKey],
      );
      if (existing.rows[0]) return { delivery_id: row.id, recorded: true, duplicate: true };
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
         VALUES($1,$2,'delivery.progress','info',$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, alias, row.request_id, row.message_id, row.id, row.trace_id,
          JSON.stringify({ text: progress.text, text_sha256: eventKey, attempt: progress.attempt,
            epoch: progress.epoch, instance_id: progress.instance_id })],
      );
      await insertProgressRelay(client, row, progress.attempt, await this.loadChainPolicy(client),
        this.rootMessageId(row), 'progress', progress.text, eventKey);
      return { delivery_id: row.id, recorded: true, duplicate: false };
    });
  }
}
