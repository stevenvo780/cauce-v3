import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startDeliveryRuntime, type DeliveryRuntime } from './b2-delivery-runtime.js';

let runtime: DeliveryRuntime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });

describe('delivery outbox through real gateway, WebSocket, reaper and PostgreSQL', () => {
  it('survives gateway restart while offline and delivers one durable message after reconnecting', async () => {
    runtime = await startDeliveryRuntime();
    const marker = `B2-OFFLINE-${randomUUID()}`;
    const key = randomUUID();
    const first = await runtime.publish(marker, key);
    const pending = await runtime.database.pool.query(`SELECT o.status FROM adapter_outbox o
      JOIN messages m ON m.id=o.message_id WHERE m.body->>'text'=$1 AND o.kind='wake'`, [marker]);
    expect(pending.rows).toEqual([{ status: 'pending' }]);
    await runtime.restartGateway();
    expect(await runtime.publish(marker, key)).toMatchObject({ ...(first as object), duplicate: true });
    const { wire, epoch } = await runtime.connect();
    const delivery = await wire.next('delivery');
    expect(delivery.body.text).toBe(marker);
    await wire.next('wake');
    const pool = runtime.database.pool;
    await expect.poll(async () => (await pool.query<{ status: string }>(
      "SELECT status FROM adapter_outbox WHERE message_id=$1 AND kind='wake'", [delivery.message_id])).rows[0]?.status)
      .toBe('sent');
    const ack = runtime.ack(delivery, epoch);
    expect(await runtime.request('/v3/ack', { ...ack, delivery_id: delivery.delivery_id }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
    expect(await runtime.request('/v3/ack', { ...ack, delivery_id: delivery.delivery_id }))
      .toMatchObject({ status: 200, body: { applied: false } });
    const effects = await runtime.database.pool.query(`SELECT
      (SELECT count(*)::int FROM messages WHERE body->>'text'=$1) AS messages,
      (SELECT count(*)::int FROM deliveries WHERE message_id=$2) AS deliveries,
      (SELECT count(*)::int FROM delivery_acks WHERE event_id=$3) AS acks`, [marker, delivery.message_id, ack.event_id]);
    expect(effects.rows).toEqual([{ messages: 1, deliveries: 1, acks: 1 }]);
    const online = `B2-ONLINE-${randomUUID()}`;
    await runtime.publish(online);
    await wire.next('wake');
    const deliveredOnline = await wire.next('delivery');
    expect(deliveredOnline.body.text).toBe(online);
    await expect.poll(async () => (await pool.query<{ status: string }>(
      "SELECT status FROM adapter_outbox WHERE message_id=$1 AND kind='wake'", [deliveredOnline.message_id])).rows[0]?.status)
      .toBe('sent');
    expect(await runtime.request('/v3/ack', { delivery_id: deliveredOnline.delivery_id, ...runtime.ack(deliveredOnline, epoch) }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
  });

  it('reaps a genuinely expired unacknowledged claim and delivers its next attempt without changing SQL clocks', async () => {
    runtime = await startDeliveryRuntime();
    const marker = `B2-TIMEOUT-${randomUUID()}`;
    const { wire, epoch } = await runtime.connect();
    await runtime.publish(marker);
    const lost = await wire.next('delivery');
    runtime.startReaper();
    const retried = await wire.next('delivery');
    expect(retried).toMatchObject({ delivery_id: lost.delivery_id, attempt: lost.attempt + 1, body: { text: marker } });
    expect(retried.claim_token).not.toBe(lost.claim_token);
    expect(await runtime.request('/v3/ack', { delivery_id: lost.delivery_id, ...runtime.ack(lost, epoch) }))
      .toMatchObject({ status: 200, body: { applied: false } });
    expect(await runtime.request('/v3/ack', { delivery_id: retried.delivery_id, ...runtime.ack(retried, epoch) }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
    expect((await runtime.database.pool.query('SELECT status,attempt FROM deliveries WHERE id=$1', [lost.delivery_id])).rows)
      .toEqual([{ status: 'done', attempt: 2 }]);
  });

  it('holds an expired execution for manual replay and makes the replay observable through the public agent route', async () => {
    runtime = await startDeliveryRuntime();
    const { wire, epoch } = await runtime.connect();
    await runtime.publish(`B2-AMBIGUOUS-${randomUUID()}`, randomUUID(), 'socrates');
    const original = await wire.next('delivery');
    expect(await runtime.request('/v3/ack', { delivery_id: original.delivery_id,
      ...runtime.ack(original, epoch, { status: 'started', execution_started: true }) }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'started' } });
    runtime.startReaper();
    const pool = runtime.database.pool;
    await expect.poll(async () => (await pool.query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1',
      [original.delivery_id])).rows[0]?.status, { timeout: 15_000 }).toBe('dead');
    expect((await pool.query('SELECT reason FROM dead_letters WHERE delivery_id=$1', [original.delivery_id])).rows)
      .toHaveLength(1);
    expect((await pool.query(`SELECT decision FROM audit_events WHERE delivery_id=$1 AND action='delivery.ack_timeout'`,
      [original.delivery_id])).rows).toEqual([{ decision: 'deny' }]);
    expect((await runtime.request(`/v3/agent/deliveries/${original.delivery_id}/retry`, {})).status).toBe(404);
    const replay = await runtime.request(`/v3/agent/deliveries/${original.delivery_id}/retry`, {}, 'socrates');
    expect(replay.status).toBe(200);
    const recovered = await wire.next('delivery');
    expect(recovered.delivery_id).not.toBe(original.delivery_id);
    expect(recovered.body.text).toBe(original.body.text);
    expect(await runtime.request('/v3/ack', { delivery_id: recovered.delivery_id, ...runtime.ack(recovered, epoch) }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
  });

  it('reschedules a preflight failure and completes the next attempt through the durable retry wake', async () => {
    runtime = await startDeliveryRuntime();
    const { wire, epoch } = await runtime.connect();
    await runtime.publish(`B2-PREFLIGHT-${randomUUID()}`);
    const failed = await wire.next('delivery');
    expect(await runtime.request('/v3/ack', { delivery_id: failed.delivery_id,
      ...runtime.ack(failed, epoch, { status: 'failed', retryable: true, error_code: 'PROCESS_EXIT_PREFLIGHT',
        error: 'Synthetic process exited before executing the turn' }) }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'retry' } });
    const recovered = await wire.next('delivery');
    expect(recovered).toMatchObject({ delivery_id: failed.delivery_id, attempt: failed.attempt + 1 });
    expect(recovered.claim_token).not.toBe(failed.claim_token);
    expect(await runtime.request('/v3/ack', { delivery_id: recovered.delivery_id, ...runtime.ack(recovered, epoch) }))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
    const pool = runtime.database.pool;
    await expect.poll(async () => (await pool.query<{ status: string }>(
      "SELECT status FROM adapter_outbox WHERE idempotency_key=$1",
      [`wake-retry:${failed.delivery_id}:${String(failed.attempt)}`])).rows[0]?.status).toBe('sent');
  });
});
