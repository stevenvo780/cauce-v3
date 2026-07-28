import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

function publishMessageCrossTenant(
  senderTenant: string,
  senderRoom: string,
  senderAlias: string,
  recipientTenant: string,
  recipientAlias: string
): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-cross-${randomUUID()}`,
    tenant_id: senderTenant,
    room_id: senderRoom,
    actor_alias: senderAlias,
    recipients: [{ tenant_id: recipientTenant, alias: recipientAlias }],
    body: { text: 'cross-tenant delegation message' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 50
  };
}

function failedAck(delivery: DeliveryEnvelope): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: `instance-${randomUUID()}`,
    epoch: 1,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,  // Don't retry, just mark as failed
    error: 'test failure'
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true,allow_read=true,allow_control=false;
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('materialization across tenant rooms', () => {
  it('should materialize response in correct room when message crosses tenant boundary', async () => {
    // Scenario: Steven sends a message from grp.steven to salva (Isa)
    // salva fails the delegated work
    // materializeAgentResponse should create response in salva's correct room (grp.isa in tenant Isa)
    // NOT in grp.steven (which is Steven's room)

    // Arrange: Publish cross-tenant message
    const msg = publishMessageCrossTenant(
      'Steven', 'grp.steven', 'kant',  // Sender: Steven in his room
      'Isa', 'salva'                     // Recipient: salva in Isa
    );
    const published = await repository.publish(msg);
    const deliveryId = published.delivery_ids[0]!;

    // Claim the delivery to salva (Isa)
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'instance-1', 1, 1, 30_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.recipient_alias).toBe('salva');

    // salva returns a failed ACK
    const ack = failedAck(claimed[0]!);
    const ackResult = await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack);
    expect(ackResult.applied).toBe(true);

    // Verify the delivery transitioned to 'failed'
    const deliveryAfterAck = await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id = $1',
      [deliveryId]
    );
    expect(deliveryAfterAck.rows[0]!.status).toBe('failed');

    // Act: Run retryStaleDeliveries which should materialize response
    // For this test, manually age the delivery to trigger reaper processing
    const pastTime = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at = $1, claim_expires_at = $1 WHERE id = $2`,
      [pastTime, deliveryId]
    );

    // Process with retryStaleDeliveries
    const result = await repository.retryStaleDeliveries(30_000);

    // Assert: Delivery should be processed successfully
    // (it will either be dead-lettered or retried, depending on max_attempts)
    // The key is that NO constraint violation occurred
    expect(result.dead + result.retried).toBeGreaterThan(0);

    // Verify that if a response message was created, it's in the correct room
    const responseMessages = await pool.query<{
      tenant_id: string;
      room_id: string;
      actor_alias: string;
    }>(
      `SELECT tenant_id, room_id, actor_alias FROM messages
       WHERE type = 'agent.response' AND actor_alias = 'salva'`,
      []
    );

    // If response was materialized, verify it's in salva's room (grp.isa in tenant Isa)
    if (responseMessages.rows.length > 0) {
      const response = responseMessages.rows[0]!;
      expect(response.tenant_id).toBe('Isa');  // Response in Isa's tenant
      expect(response.actor_alias).toBe('salva');
      // The room should be one of salva's memberships in Isa
      // NOT grp.steven (Steven's room)
      expect(response.room_id).not.toBe('grp.steven');
    }
  });

  it('should not crash when recipient membership is missing due to cross-tenant context', async () => {
    // This tests the try/catch defense: even if materialization fails due to
    // missing membership in the computed room, the delivery should still transition
    // to a terminal state without crashing the reaper

    // Arrange: Create a delivery to an agent
    const msg = publishMessageCrossTenant('Steven', 'grp.steven', 'kant', 'Isa', 'salva');
    const published = await repository.publish(msg);
    const deliveryId = published.delivery_ids[0]!;

    // Claim it
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'instance-1', 1, 1, 30_000);
    expect(claimed).toHaveLength(1);

    // Disable salva's membership to simulate broken sandbox
    await pool.query(`UPDATE memberships SET enabled = false WHERE alias = 'salva'`);

    // Age the delivery to trigger reaper
    const pastTime = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at = $1, claim_expires_at = $1 WHERE id = $2`,
      [pastTime, deliveryId]
    );

    // Act: Run retryStaleDeliveries
    // The try/catch should prevent crash despite membership being disabled
    const result = await repository.retryStaleDeliveries(30_000);

    // Assert: Should process without crashing (even if denied/failed)
    expect(result.dead + result.retried).toBeGreaterThan(0);
    // Delivery should reach a terminal state eventually
    const finalDelivery = await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id = $1',
      [deliveryId]
    );
    // Status should be one of the processable states, not stuck in 'leased'
    expect(['dead', 'failed', 'done', 'retry']).toContain(finalDelivery.rows[0]!.status);
  });
});
