import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import {
  CauceRepository,
  type ClaimedOutboxEvent,
  type DatabasePool,
  type FencedWakeOutboxRecipient,
} from '../src/index.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

function command(recipients: PublishMessage['recipients']): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `connection-fence-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients,
    body: { text: 'connection fencing test' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
  };
}

async function fencedRecipient(
  tenant_id: FencedWakeOutboxRecipient['tenant_id'],
  alias: string,
  instance_id: string,
): Promise<FencedWakeOutboxRecipient> {
  const lease = await repository.acquireLease(
    tenant_id,
    alias,
    instance_id,
    ['renewable_delivery_claims_v1'],
    60_000,
  );
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
    throw new Error('expected a fenced lease');
  }
  return {
    tenant_id,
    alias,
    instance_id,
    epoch: lease.epoch,
    connection_token: lease.connection_token,
  };
}

function claimFence(event: ClaimedOutboxEvent, connection: FencedWakeOutboxRecipient) {
  return {
    event_id: event.event_id,
    attempt: event.attempt,
    claim_token: event.claim_token,
    worker: event.claimed_by,
    connection,
  };
}

describe('connection session fencing', () => {
  it('rotates on every resume and prevents the prior socket from heartbeat, claim or release', async () => {
    const instanceId = 'same-stable-instance';
    const first = await fencedRecipient('Isa', 'salva', instanceId);
    await repository.publish(command([{ tenant_id: 'Isa', alias: 'salva' }]));

    const resumed = await repository.acquireLease(
      'Isa',
      'salva',
      instanceId,
      ['renewable_delivery_claims_v1'],
      60_000,
      { resume: true, resumeWindowMs: 60_000 },
    );
    expect(resumed).toMatchObject({ acquired: true, epoch: first.epoch });
    expect(resumed.connection_token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(resumed.connection_token).not.toBe(first.connection_token);
    const currentToken = resumed.connection_token!;

    await expect(repository.heartbeat(
      'Isa', 'salva', instanceId, first.epoch, 60_000, first.connection_token,
    )).rejects.toMatchObject({ code: 'fenced' });
    await expect(repository.claimDeliveries(
      'Isa', 'salva', instanceId, first.epoch, 1, 30_000, 3, {}, first.connection_token,
    )).rejects.toMatchObject({ code: 'fenced' });

    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', instanceId, first.epoch, 1, 30_000, 3, {}, currentToken,
    );
    expect(delivery).toBeDefined();
    expect(await repository.releaseLease(
      'Isa', 'salva', instanceId, first.epoch, first.connection_token,
    )).toBe(false);
    expect((await pool.query<{ live: boolean; delivery_live: boolean }>(
      `SELECT lease_until>now() AS live,
              EXISTS(
                SELECT 1 FROM deliveries
                 WHERE id=$1 AND status='leased' AND claim_expires_at>now()
              ) AS delivery_live
         FROM connection_leases WHERE tenant_id='Isa' AND alias='salva'`,
      [delivery!.delivery_id],
    )).rows[0]).toEqual({ live: true, delivery_live: true });
    await expect(repository.heartbeat(
      'Isa', 'salva', instanceId, first.epoch, 60_000, currentToken,
    )).resolves.toMatch(/T/u);
  });

  it('claims one wake per rotated identity and fences renew/ACK by exact session and CAS', async () => {
    const isa = await fencedRecipient('Isa', 'salva', 'isa-session');
    const pablo = await fencedRecipient('Pablo', 'midas', 'pablo-session');
    await Promise.all([
      repository.publish(command([{ tenant_id: 'Isa', alias: 'salva' }])),
      repository.publish(command([{ tenant_id: 'Isa', alias: 'salva' }])),
      repository.publish(command([{ tenant_id: 'Isa', alias: 'salva' }])),
      repository.publish(command([{ tenant_id: 'Pablo', alias: 'midas' }])),
    ]);

    const claimed = await repository.claimWakeOutbox(
      'gateway-batch',
      [pablo, isa],
      2,
      30_000,
    );
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((event) =>
      `${event.tenant_id}:${String(event.payload.recipient_alias)}`))).toEqual(
      new Set(['Pablo:midas', 'Isa:salva']),
    );

    const pabloEvent = claimed.find((event) => event.tenant_id === 'Pablo')!;
    await expect(repository.renewWakeOutbox(
      claimFence(pabloEvent, pablo),
      30_000,
    )).resolves.toBe(true);
    await expect(repository.renewWakeOutbox({
      ...claimFence(pabloEvent, pablo),
      claim_token: randomUUID(),
    }, 30_000)).resolves.toBe(false);

    const resumed = await repository.acquireLease(
      'Pablo',
      'midas',
      pablo.instance_id,
      ['renewable_delivery_claims_v1'],
      60_000,
      { resume: true, resumeWindowMs: 60_000 },
    );
    expect(resumed.connection_token).not.toBe(pablo.connection_token);
    await expect(repository.renewWakeOutbox(
      claimFence(pabloEvent, pablo),
      30_000,
    )).resolves.toBe(false);
    await expect(repository.ackOutbox({
      event_id: pabloEvent.event_id,
      attempt: pabloEvent.attempt,
      claim_token: pabloEvent.claim_token,
      status: 'sent',
      connection: pablo,
    })).resolves.toEqual({ status: 'failed', applied: false });

    const isaEvent = claimed.find((event) => event.tenant_id === 'Isa')!;
    await pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()-interval '1 millisecond' WHERE id=$1`,
      [isaEvent.id],
    );
    await expect(repository.renewWakeOutbox(
      claimFence(isaEvent, isa),
      30_000,
    )).resolves.toBe(false);
    await expect(repository.ackOutbox({
      event_id: isaEvent.event_id,
      attempt: isaEvent.attempt,
      claim_token: isaEvent.claim_token,
      status: 'sent',
      connection: isa,
    })).resolves.toEqual({ status: 'failed', applied: false });
  });

  it('does not let a stale wake snapshot consume another attempt after token rotation', async () => {
    const stale = await fencedRecipient('Isa', 'salva', 'rotated-wake-session');
    await repository.publish(command([{ tenant_id: 'Isa', alias: 'salva' }]));
    const resumed = await repository.acquireLease(
      'Isa',
      'salva',
      stale.instance_id,
      ['renewable_delivery_claims_v1'],
      60_000,
      { resume: true, resumeWindowMs: 60_000 },
    );
    const current: FencedWakeOutboxRecipient = {
      ...stale,
      connection_token: resumed.connection_token!,
    };
    await expect(repository.claimWakeOutbox(
      'stale-gateway', [stale], 1, 30_000,
    )).resolves.toEqual([]);
    expect((await pool.query<{ attempts: number }>(
      `SELECT attempts FROM adapter_outbox
        WHERE kind='wake' AND tenant_id='Isa' AND payload->>'recipient_alias'='salva'`,
    )).rows[0]).toEqual({ attempts: 0 });
    await expect(repository.claimWakeOutbox(
      'current-gateway', [current], 1, 30_000,
    )).resolves.toHaveLength(1);
  });
});
