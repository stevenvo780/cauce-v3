import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
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

/**
 * The ACK must come from the SAME identity that claimed the delivery.
 *
 * 🔴 `instance_id` and `epoch` were being made up here (`instance-${randomUUID()}`, `epoch: 1`) and did not
 * match the lease, so `ackDelivery` rejected them with "ACK identity does not own this delivery claim". It is
 * the same fencing that was already making `claimDeliveries` above fail, one step later: an ACK that does not
 * prove it came from the claimer could close someone else's turn.
 *
 * They are passed as parameters rather than hardcoded for the same reason as `epoch`: those are values the
 * repository decides, and writing them by hand ties the test back to a number it does not control.
 */
function failedAck(delivery: DeliveryEnvelope, instanceId: string, epoch: number): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,  // Don't retry, just mark as failed
    error: 'test failure'
  };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
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
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('materialization across tenant rooms', () => {
  it('should materialize response in correct room when message crosses tenant boundary', async () => {
    // Scenario: Steven sends a message from grp.steven to salva (Isa)
    // salva fails the delegated work
    // materializeAgentResponse should create response in salva's correct room (grp.isa in tenant Isa)
    // NOT in grp.steven (which is Steven's room)

    /*
     * THE DELEGATION IS CREATED AS IN PRODUCTION: by the parent's ACK, not by publishing it.
     *
     * This test was publishing a standalone message from `kant` to `salva` and calling it a "delegation". It
     * was not: without a parent, `materializeAgentResponse` returns `'not_child'` and does NOT write any
     * `agent.response`. Measured with a probe: the final query found ZERO rows, so the three assertions about
     * the room — the ones that give the test its name, "that it lands in Isa's and NOT in grp.steven" — lived
     * inside an `if (rows.length > 0)` that was never true. A perfect green over zero checks, which is the
     * worst kind of test there is.
     *
     * You also cannot publish `body.type = 'agent.message'` by hand: it is a reserved internal type and
     * `publish()` rightly rejects it. The only way a delegation exists is if an agent delegates, so that is
     * what we do: `kant` receives a task and its ACK carries a `messages` toward `salva`, which is in ANOTHER
     * tenant. That is where the cross-tenant delivery comes from.
     */
    const leaseKant = await repository.acquireLease('Steven', 'kant', 'kant-1', [], 30_000);
    expect(leaseKant.acquired).toBe(true);
    await repository.publish(publishMessageCrossTenant(
      'Steven', 'grp.steven', 'kant', 'Steven', 'kant',
    ));
    const [paraKant] = await repository.claimDeliveries(
      'Steven', 'kant', 'kant-1', requireValue(leaseKant.epoch, 'leaseKant.epoch'), 1, 30_000,
    );
    expect(paraKant).toBeDefined();
    await repository.ackDelivery(requireValue(paraKant, 'paraKant').delivery_id, 'Steven', 'kant', {
      version: '3.0',
      event_id: randomUUID(),
      status: 'done',
      instance_id: 'kant-1',
      epoch: requireValue(leaseKant.epoch, 'leaseKant.epoch'),
      claim_token: requireValue(paraKant, 'paraKant').claim_token,
      attempt: requireValue(paraKant, 'paraKant').attempt,
      retryable: false,
      result: {
        output: {
          reply: null,
          messages: [{ to: 'salva', body: 'hacé la parte que te toca' }],
          notify: [],
          status: 'done',
          retryable: false,
          artifacts: [],
        },
      },
    } as unknown as Ack);

    // The delivery that came out of that delegation, already in salva's tenant.
    const cruzada = await pool.query<{ id: string }>(
      `SELECT d.id FROM deliveries d
       WHERE d.recipient_tenant='Isa' AND d.recipient_alias='salva' ORDER BY d.created_at DESC LIMIT 1`,
    );
    expect(cruzada.rowCount).toBe(1);
    const deliveryId = requireValue(cruzada.rows[0], 'cruzada.rows').id;

    /*
     * 🔴 THE LEASE WAS MISSING, which is why these two tests had been red.
     *
     * `claimDeliveries` requires a live connection lease with the SAME `instance_id` and the
     * SAME `epoch`, and fails with "delivery claim rejected by lease fencing". This test was
     * claiming bare-knuckle with made-up `instance-1` and `epoch 1`, so it could only pass on a
     * database where ANOTHER suite had left a coincidentally compatible lease — and
     * `resetTestDatabase()` truncates `connection_leases`, so even that was impossible.
     *
     * `epoch` is taken from what `acquireLease` returns and is not written by hand for the
     * same reason: hardcoding 1 ties the test back to a value the repository decides.
     */
    const lease = await repository.acquireLease('Isa', 'salva', 'instance-1', [], 30_000);
    expect(lease.acquired).toBe(true);

    // Claim the delivery to salva (Isa)
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'instance-1', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
    expect(claimed).toHaveLength(1);
    expect(requireValue(claimed[0], 'claimed').recipient_alias).toBe('salva');

    // salva returns a failed ACK
    const ack = failedAck(requireValue(claimed[0], 'claimed'), 'instance-1', requireValue(lease.epoch, 'lease.epoch'));
    const ackResult = await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack);
    expect(ackResult.applied).toBe(true);

    // Verify the delivery transitioned to 'failed'
    const deliveryAfterAck = await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id = $1',
      [deliveryId]
    );
    expect(requireValue(deliveryAfterAck.rows[0], 'deliveryAfterAck.rows').status).toBe('failed');

    /*
     * The reaper has NOTHING to do here, and that is the assertion that matters.
     *
     * This test required `result.dead + result.retried > 0`, i.e. that the reaper FOUND the
     * delivery. That could only be true while the ACK was not being applied — the test did not
     * acquire a lease and died earlier, in `claimDeliveries`. With the correct lease and ACK
     * identity, the ACK closes the delivery in `failed`, which is a TERMINAL state: the reaper
     * rightly ignores it.
     *
     * The assertion is inverted rather than deleted because its opposite is an invariant that
     * matters: a reaper that touched a delivery already closed by its owner would retry it, and
     * the agent would pay twice for work it already did. Aging it by hand is precisely the trap
     * that would expose it.
     */
    const pastTime = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at = $1, claim_expires_at = $1 WHERE id = $2`,
      [pastTime, deliveryId]
    );

    const result = await repository.retryStaleDeliveries(30_000);
    expect(result.dead + result.retried).toBe(0);

    // And it stays closed where the ACK left it: the reaper did not move it.
    const trasElReaper = await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id = $1', [deliveryId]
    );
    expect(requireValue(trasElReaper.rows[0], 'trasElReaper.rows').status).toBe('failed');

    // Verify that if a response message was created, it's in the correct room
    const responseMessages = await pool.query<{
      tenant_id: string;
      room_id: string;
      actor_alias: string;
    }>(
      /*
       * The message type lives in `body->>'type'`, NOT in a `type` column — which does not
       * exist. This query had been blowing up forever with `column "type" does not exist`,
       * hidden by the three earlier failures of this same test (no lease, ACK without identity,
       * and a reaper assertion that could no longer be true). Each one hid the next.
       */
      `SELECT tenant_id, room_id, actor_alias FROM messages
       WHERE body->>'type' = 'agent.response' AND actor_alias = 'salva'`,
      []
    );

    /*
     * NO `if`. The `if (rows.length > 0)` guard made the test pass without having checked
     * ANYTHING its name promises. If the response ever stops materializing, this must go red
     * here and not pretend it is still covered.
     */
    expect(responseMessages.rows.length).toBeGreaterThan(0);
    const response = requireValue(responseMessages.rows[0], 'responseMessages.rows');
    expect(response.tenant_id).toBe('Isa');  // the response lives in salva's tenant
    expect(response.actor_alias).toBe('salva');
    // And in a room of HER own, never in the delegator's: that is the bug this test hunts.
    expect(response.room_id).not.toBe('grp.steven');
  });

  it('should not crash when recipient membership is missing due to cross-tenant context', async () => {
    // This tests the try/catch defense: even if materialization fails due to
    // missing membership in the computed room, the delivery should still transition
    // to a terminal state without crashing the reaper

    // Arrange: Create a delivery to an agent
    const msg = publishMessageCrossTenant('Steven', 'grp.steven', 'kant', 'Isa', 'salva');
    const published = await repository.publish(msg);
    const deliveryId = requireValue(published.delivery_ids[0], 'published.delivery_ids');

    // Claim it — with its own lease, for the same reason as the test above.
    const lease = await repository.acquireLease('Isa', 'salva', 'instance-1', [], 30_000);
    expect(lease.acquired).toBe(true);
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'instance-1', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
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
    expect(['dead', 'failed', 'done', 'retry']).toContain(requireValue(finalDelivery.rows[0], 'finalDelivery.rows').status);
  });
});

describe('system principal delegation targets', () => {
  it('rejects an agent-to-agent delegation aimed at a system principal alias', async () => {
    await pool.query(`
      INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
        ('Steven','grp.steven','quota-collector','operator')
      ON CONFLICT DO NOTHING;
      UPDATE memberships SET enabled=true WHERE alias='quota-collector';
    `);

    const lease = await repository.acquireLease('Steven', 'kant', 'kant-sysprincipal', [], 30_000);
    expect(lease.acquired).toBe(true);
    await repository.publish(publishMessageCrossTenant(
      'Steven', 'grp.steven', 'kant', 'Steven', 'kant',
    ));
    const [claimed] = await repository.claimDeliveries(
      'Steven', 'kant', 'kant-sysprincipal', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000,
    );
    expect(claimed).toBeDefined();
    const delivery = requireValue(claimed, 'claimed');

    await repository.ackDelivery(delivery.delivery_id, 'Steven', 'kant', {
      version: '3.0',
      event_id: randomUUID(),
      status: 'done',
      instance_id: 'kant-sysprincipal',
      epoch: requireValue(lease.epoch, 'lease.epoch'),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false,
      result: {
        output: {
          reply: null,
          messages: [{ to: 'quota-collector', body: 'reclama trabajo del recolector de cuotas' }],
          notify: [],
          status: 'done',
          retryable: false,
          artifacts: [],
        },
      },
    } as unknown as Ack);

    const delivered = await pool.query<{ id: string }>(
      `SELECT id FROM deliveries WHERE recipient_alias='quota-collector'`,
    );
    expect(delivered.rowCount).toBe(0);

    const rejected = await pool.query<{ status: string; rejection_code: string | null }>(
      `SELECT status, rejection_code FROM agent_output_materializations
       WHERE source_alias='kant' AND source_delivery_id=$1`,
      [delivery.delivery_id],
    );
    expect(rejected.rowCount).toBe(1);
    expect(requireValue(rejected.rows[0], 'rejected.rows')).toMatchObject({
      status: 'rejected',
      rejection_code: 'unroutable_alias',
    });
  });
});
