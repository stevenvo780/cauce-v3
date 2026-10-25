import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fencingReceipt, startRuntimeLeaseFixture, type RuntimeLeaseFixture } from './runtime-lease-fencing.helpers.js';

let fixture: RuntimeLeaseFixture | undefined;
const active = (): RuntimeLeaseFixture => {
  if (!fixture) throw new Error('Runtime lease fixture unavailable');
  return fixture;
};
beforeAll(async () => { fixture = await startRuntimeLeaseFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); });

describe('Runtime lease fencing through production mTLS and PostgreSQL', () => {
  it('admits a V3 baseline without host on server2 and persists its delivery ACK', async () => {
    const current = active();
    const baseline = await current.pool.query(`SELECT agent.runtime_mode,agent.host_id,identity.baseline,
        identity.baseline_state->>'host_id' AS baseline_host,identity.baseline_state->>'runtime_mode' AS baseline_mode
      FROM agents agent JOIN fleet_runtime_identities identity ON identity.runtime_key=agent.runtime_key
      WHERE agent.tenant_id='Steven' AND agent.alias=$1`, [current.worker]);
    expect(baseline.rows).toEqual([{ runtime_mode: null, host_id: 'server2', baseline: true, baseline_host: null, baseline_mode: null }]);
    const consumer = await current.connectRemote(current.worker);
    const hello = await consumer.next('hello_ack');
    expect(hello.hostname).toBe('zz-canary-server2');
    const marker = `lease-message-${randomUUID()}`;
    expect(await current.publish(current.worker, marker)).toMatchObject({ status: 202 });
    const delivery = await consumer.next('delivery');
    expect(delivery.message_sha256).toBe(createHash('sha256').update(marker).digest('hex'));
    const ack = await consumer.next('ack_result');
    expect(ack).toMatchObject({ applied: true, status: 'done', delivery_id: delivery.delivery_id });
    const persisted = await current.pool.query(`SELECT delivery.status,ack.applied,ack.status AS ack_status
      FROM deliveries delivery JOIN delivery_acks ack ON ack.delivery_id=delivery.id
      WHERE delivery.id=$1 AND ack.event_id=$2`, [delivery.delivery_id, ack.event_id]);
    expect(persisted.rows).toEqual([{ status: 'done', applied: true, ack_status: 'done' }]);
    expect(await consumer.next('heartbeat_ack')).toMatchObject({ event: 'heartbeat_ack' });
    expect(current.remoteAddresses).toContain(consumer.ipAddress);
    await fencingReceipt('v3-server2-roundtrip', { result: 'PASA', helloAck: true, heartbeatAck: true,
      controllerHost: 'server', durableHost: 'server2', baselineHost: null, persistedAck: persisted.rows,
      adapterHostname: hello.hostname, adapterIpAddress: consumer.ipAddress, sourceAddresses: current.remoteAddresses,
      messageSha256: createHash('sha256').update(marker).digest('hex') });
  });

  it('rejects the old V3 heartbeat and a new V3 hello after durable placement changes to V4', async () => {
    const current = active();
    const consumer = await current.connectRemote(current.moving);
    const hello = await consumer.next('hello_ack');
    expect(hello.hostname).toBe('zz-canary-server2');
    const moved = await current.pool.query(`UPDATE agents SET runtime_mode='native',host_id='targethost'
      WHERE tenant_id='Steven' AND alias=$1 AND runtime_mode IS NULL AND host_id='server2'`, [current.moving]);
    expect(moved.rowCount).toBe(1);
    expect(await consumer.next('error')).toMatchObject({ code: 'consumer_placement_mismatch' });
    expect(await consumer.next('closed')).toMatchObject({ event: 'closed' });
    const stale = await current.connect(current.moving);
    expect(await stale.next('error')).toMatchObject({ code: 'consumer_placement_mismatch' });
    const rejections = await current.pool.query<{ phase: string; decision: string }>(`SELECT metadata->>'phase' AS phase,decision
      FROM audit_events WHERE tenant_id='Steven' AND actor_alias=$1 AND action='connection.lease.rejected' ORDER BY id`, [current.moving]);
    expect(rejections.rows).toEqual([{ phase: 'heartbeat', decision: 'deny' }, { phase: 'hello', decision: 'deny' }]);
    expect((await current.pool.query(`SELECT 1 FROM connection_leases
      WHERE tenant_id='Steven' AND alias=$1 AND instance_id=$2`, [current.moving, stale.instance])).rowCount).toBe(0);
    await fencingReceipt('v4-rejects-stale-v3', { result: 'PASA', oldHeartbeatRejected: true, newHelloRejected: true,
      errorCode: 'consumer_placement_mismatch', newLeaseAbsent: true, persistedAudit: rejections.rows });
  });
});
