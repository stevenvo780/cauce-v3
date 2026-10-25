import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;
const instance = 'consumption-adapter';
const evidence = {
  version: 1, harness_id: 'claude', native_session_id: 'session-a', native_turn_id: 'turn-a',
  input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response',
} as const;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES ('Steven','kant','codex','Kant',true,'ws-kant','dev','/home/dev','/home/dev/.cauce/kant'),
      ('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/home/dev/.cauce/argos')
    ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true,harness_id=EXCLUDED.harness_id;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
});

afterAll(async () => {
  if (database === undefined) return;
  try {
    await database.pool.end();
  } finally {
    await database.container.stop();
  }
});

async function claim(): Promise<{ delivery: DeliveryEnvelope; epoch: number }> {
  const lease = await repository.acquireLease('Steven', 'argos', instance, [], 30_000, { resume: true });
  if (!lease.acquired || lease.epoch === undefined) throw new Error('missing consumer lease');
  const message: PublishMessage = {
    version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: 'Steven',
    room_id: 'grp.steven', actor_alias: 'kant', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'ping' }, idempotency_key: randomUUID(), lane: 'interactive', priority: 7,
  };
  await repository.publish(message);
  const [delivery] = await repository.claimDeliveries('Steven', 'argos', instance, lease.epoch, 1, 30_000);
  if (delivery === undefined) throw new Error('missing delivery');
  return { delivery, epoch: lease.epoch };
}

function ack(delivery: DeliveryEnvelope, epoch: number, witness: unknown): Ack {
  return {
    version: '3.0', event_id: randomUUID(), status: 'done', instance_id: instance, epoch,
    claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false,
    result: { output: { reply: 'pong', status: 'done', retryable: false, messages: [], notify: [], artifacts: [] },
      harness_consumption_v1: witness },
  };
}

async function timeline(delivery: DeliveryEnvelope) {
  const page = await repository.listMessages('Steven', 'kant');
  const items = page.items as { deliveries: { delivery_id: string; timeline: Record<string, unknown>[] }[] }[];
  const found = items.flatMap((item) => item.deliveries).find((item) => item.delivery_id === delivery.delivery_id);
  if (found === undefined) throw new Error('missing visible delivery');
  return found.timeline;
}

async function loginState(delivery: DeliveryEnvelope) {
  const page = await repository.listMessages('Steven', 'kant');
  const rows = page.items as { deliveries: { delivery_id: string; provider_login_required: boolean }[] }[];
  const message = rows.flatMap(row => row.deliveries).find(row => row.delivery_id === delivery.delivery_id);
  const snapshot = await repository.fleetActivity('Steven', 'kant') as {
    agents: { tenant_id: string; alias: string; provider_login_required: boolean }[];
  };
  const agent = snapshot.agents.find(row => row.tenant_id === 'Steven' && row.alias === 'argos');
  return { message: message?.provider_login_required, agent: agent?.provider_login_required, page, snapshot };
}

function loginAck(delivery: DeliveryEnvelope, epoch: number): Ack {
  return { ...ack(delivery, epoch, undefined), status: 'failed', retryable: true,
    error_code: 'PROVIDER_LOGIN_REQUIRED', error: 'zz-canary-private-provider-prompt' };
}

describe('durable consumption receipt projection', () => {
  it('projects only an applied provider login failure and keeps unrelated errors from clearing it', async () => {
    const first = await claim();
    const rejected = { ...loginAck(first.delivery, first.epoch), claim_token: randomUUID() };
    expect((await repository.ackDelivery(first.delivery.delivery_id, 'Steven', 'argos', rejected)).applied).toBe(false);
    expect(await loginState(first.delivery)).toMatchObject({ message: false, agent: false });
    expect(await repository.ackDelivery(first.delivery.delivery_id, 'Steven', 'argos', loginAck(first.delivery, first.epoch)))
      .toMatchObject({ status: 'retry', applied: true });
    const failed = await loginState(first.delivery);
    expect(failed).toMatchObject({ message: true, agent: true });
    expect(JSON.stringify(failed)).not.toContain('zz-canary-private-provider-prompt');
    expect(JSON.stringify(failed)).not.toContain('PROVIDER_LOGIN_REQUIRED');
    await pool.query("UPDATE deliveries SET available_at=now()+interval '1 hour' WHERE id=$1", [first.delivery.delivery_id]);
    const other = await claim();
    const unrelated = { ...loginAck(other.delivery, other.epoch), error_code: 'NETWORK_UNAVAILABLE', retryable: false };
    await repository.ackDelivery(other.delivery.delivery_id, 'Steven', 'argos', unrelated);
    expect(await loginState(first.delivery)).toMatchObject({ message: true, agent: true });
    const healthy = await claim();
    const wrongDone = { ...ack(healthy.delivery, healthy.epoch, evidence), claim_token: randomUUID() };
    expect((await repository.ackDelivery(healthy.delivery.delivery_id, 'Steven', 'argos', wrongDone)).applied).toBe(false);
    expect((await loginState(first.delivery)).agent).toBe(true);
    await repository.ackDelivery(healthy.delivery.delivery_id, 'Steven', 'argos', ack(healthy.delivery, healthy.epoch, evidence));
    expect(await loginState(first.delivery)).toMatchObject({ message: true, agent: false });
  });

  it('clears a retried message after a healthy later attempt and ignores rejected old claims across epochs', async () => {
    const first = await claim();
    await repository.ackDelivery(first.delivery.delivery_id, 'Steven', 'argos', loginAck(first.delivery, first.epoch));
    await repository.releaseLease('Steven', 'argos', instance, first.epoch);
    const lease = await repository.acquireLease('Steven', 'argos', instance, [], 30_000);
    if (lease.epoch === undefined) throw new Error('missing replacement consumer lease');
    expect(lease.epoch).toBeGreaterThan(first.epoch);
    expect(await loginState(first.delivery)).toMatchObject({ message: true, agent: true });
    await pool.query('UPDATE deliveries SET available_at=now() WHERE id=$1', [first.delivery.delivery_id]);
    const [next] = await repository.claimDeliveries('Steven', 'argos', instance, lease.epoch, 1, 30_000);
    if (next === undefined) throw new Error('missing retry');
    expect(next.attempt).toBe(first.delivery.attempt + 1);
    await repository.ackDelivery(next.delivery_id, 'Steven', 'argos', ack(next, lease.epoch, evidence));
    expect(await loginState(next)).toMatchObject({ message: false, agent: false });
    expect((await repository.ackDelivery(first.delivery.delivery_id, 'Steven', 'argos', loginAck(first.delivery, first.epoch))).applied).toBe(false);
    expect(await loginState(next)).toMatchObject({ message: false, agent: false });
  });

  it('does not expose the provider signal outside readable tenant scope', async () => {
    const first = await claim();
    await repository.ackDelivery(first.delivery.delivery_id, 'Steven', 'argos', loginAck(first.delivery, first.epoch));
    await pool.query("UPDATE acl_edges SET enabled=false WHERE from_tenant='Isa'");
    const snapshot = await repository.fleetActivity('Isa', 'salva') as { agents: { tenant_id: string; alias: string }[] };
    expect(snapshot.agents.some(row => row.tenant_id === 'Steven' && row.alias === 'argos')).toBe(false);
    const page = await repository.listMessages('Isa', 'salva');
    expect(JSON.stringify(page)).not.toContain(first.delivery.message_id);
  });

  it('projects one applied witness with its real attempt and replays without another receipt', async () => {
    const { delivery, epoch } = await claim();
    const event = ack(delivery, epoch, evidence);
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', event)).applied).toBe(true);
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', event)).receipt).toBe('duplicate');
    const events = await timeline(delivery);
    expect(events.filter((item) => item.harness_consumption !== null && item.harness_consumption !== undefined))
      .toEqual([expect.objectContaining({ status: 'done', attempt: delivery.attempt, applied: true, harness_consumption: evidence })]);
  });

  it.each([
    { ...evidence, harness_id: 'codex' }, { ...evidence, prompt: 'private input' },
  ])('accepts the reply but never projects malformed or foreign-harness evidence: %j', async (invalid) => {
    const { delivery, epoch } = await claim();
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack(delivery, epoch, invalid))).applied).toBe(true);
    expect((await timeline(delivery)).every((item) => item.harness_consumption == null)).toBe(true);
  });

  it('does not turn a rejected ownership ACK into a read receipt', async () => {
    const { delivery, epoch } = await claim();
    const event = { ...ack(delivery, epoch, evidence), claim_token: randomUUID() };
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', event)).applied).toBe(false);
    expect((await timeline(delivery)).every((item) => item.harness_consumption == null)).toBe(true);
  });

  it('preserves legacy ACKs without an agent registry entry and omits their witness', async () => {
    await pool.query("DELETE FROM agents WHERE tenant_id='Steven' AND alias='argos'");
    const { delivery, epoch } = await claim();
    expect((await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack(delivery, epoch, evidence))).applied).toBe(true);
    expect((await timeline(delivery)).every((item) => item.harness_consumption == null)).toBe(true);
  });

  it('does not expose arbitrary fields stored by older ACK clients', async () => {
    const { delivery, epoch } = await claim();
    const event = ack(delivery, epoch, evidence);
    await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', event);
    await pool.query(`UPDATE delivery_acks SET payload=jsonb_set(payload,'{result,harness_consumption_v1}',$2::jsonb)
      WHERE event_id=$1`, [event.event_id, JSON.stringify({ ...evidence, prompt: 'private input', path: '/private/session.json' })]);
    const projected = await timeline(delivery);
    expect(projected.every((item) => item.harness_consumption == null)).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('private input');
    expect(JSON.stringify(projected)).not.toContain('/private/session.json');
  });
});
