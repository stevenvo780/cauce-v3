import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { QueryResultRow } from 'pg';
import type { Ack, DeliveryEnvelope, Tenant } from '@cauce/protocol';
import {
  DEFAULT_ACK_DEADLINE_MS, type CauceRepository, type DatabasePool
} from '../../src/index.js';
import { requireValue } from '../helpers.js';

/** A leased consumer: the fencing identity a suite needs to claim and to ACK. */
export interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

/** Building an ACK only needs the fencing pair, not the whole consumer. */
type AckIdentity = Pick<Consumer, 'instanceId' | 'epoch'>;
/** Building an ACK only needs the claim it answers, not the whole envelope. */
type ClaimedDelivery = Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>;

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_CLAIM_LIMIT = 10;

export async function consumer(
  repository: CauceRepository,
  tenant: Tenant,
  alias: string,
  leaseMs: number = DEFAULT_LEASE_MS
): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], leaseMs);
  return { tenant, alias, instanceId, epoch: requireValue(lease.epoch, 'lease.epoch') };
}

export async function nextDelivery(
  repository: CauceRepository,
  target: Consumer,
  predicate: (delivery: DeliveryEnvelope) => boolean = () => true,
  limit: number = DEFAULT_CLAIM_LIMIT
): Promise<DeliveryEnvelope> {
  const claimed = await repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, limit, DEFAULT_ACK_DEADLINE_MS
  );
  const delivery = claimed.find(predicate);
  if (!delivery) {
    throw new Error(`no matching delivery for ${target.alias}: ${JSON.stringify(
      claimed.map((item) => item.body.type ?? 'request')
    )}`);
  }
  return delivery;
}

/** The wire fields every ACK repeats; `result` and `overrides` carry what a suite varies. */
export function ackEnvelope(
  delivery: ClaimedDelivery,
  target: AckIdentity,
  result: Record<string, unknown>,
  overrides: Partial<Ack> = {}
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result,
    ...overrides
  };
}

export interface TerminalAckOptions {
  messages?: unknown[];
  reply?: string | null;
  status?: 'done' | 'failed';
  eventId?: string;
}

export function terminalAck(
  delivery: ClaimedDelivery,
  target: AckIdentity,
  options: TerminalAckOptions = {}
): Ack {
  const { messages = [], reply = 'done', status = 'done', eventId = randomUUID() } = options;
  return ackEnvelope(
    delivery, target,
    { output: { reply, messages, status, retryable: false, artifacts: [] } },
    { status, event_id: eventId }
  );
}

/** Applies a terminal ACK and fails the test if the store did not take it. */
export async function ackWith(
  repository: CauceRepository,
  target: Consumer,
  delivery: DeliveryEnvelope,
  options: TerminalAckOptions = {}
): Promise<Awaited<ReturnType<CauceRepository['ackDelivery']>>> {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias, terminalAck(delivery, target, options)
  );
  expect(result.applied).toBe(true);
  return result;
}

const DEFAULT_DELIVERY_COLUMNS = 'status,attempt,last_error,terminal_at';

/**
 * One delivery row by id, projected to whatever the suite asserts on. The table is aliased `d`
 * so a projection may reach for `to_jsonb(d)` when a column is younger than the tree under test.
 */
export async function deliveryRow<Row extends object>(
  pool: DatabasePool,
  id: string,
  columns: string = DEFAULT_DELIVERY_COLUMNS
): Promise<Row> {
  const result = await pool.query<QueryResultRow>(
    `SELECT ${columns} FROM deliveries d WHERE d.id=$1`, [id]
  );
  return requireValue(result.rows[0], `delivery ${id}`) as Row;
}
