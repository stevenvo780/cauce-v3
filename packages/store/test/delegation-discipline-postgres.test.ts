import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Delegation discipline (migration 019).
 *
 * The three things the owner asked for, in the same order:
 *   1. the cycling chain must be CUT, not run out of budget;
 *   2. the task that waits for a person must stop being an impossible delivery;
 *   3. the rejection must be READABLE, so it can be fixed instead of retried.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const telegramOrigin = (conversation: string) => ({
  adapter: 'telegram',
  channel: 'telegram',
  conversation_id: conversation,
  external_message_id: conversation,
  relay: [],
  metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
});

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'delegation discipline source' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}

interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  return { tenant, alias, instanceId, epoch: requireValue(lease.epoch, 'lease.epoch') };
}

async function nextDelivery(
  target: Consumer,
  predicate: (delivery: DeliveryEnvelope) => boolean = () => true
): Promise<DeliveryEnvelope> {
  const claimed = await repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, 10, 30_000
  );
  const delivery = claimed.find(predicate);
  if (!delivery) {
    throw new Error(`no matching delivery for ${target.alias}: ${JSON.stringify(
      claimed.map((item) => item.body.type ?? 'request')
    )}`);
  }
  return delivery;
}

function terminalAck(
  delivery: DeliveryEnvelope,
  target: Consumer,
  messages: unknown[],
  reply: string | null = 'done'
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
    result: { output: { reply, messages, status: 'done', retryable: false, artifacts: [] } }
  };
}

async function ackWith(
  target: Consumer,
  delivery: DeliveryEnvelope,
  messages: unknown[],
  reply: string | null = 'done'
): Promise<Awaited<ReturnType<CauceRepository['ackDelivery']>>> {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias,
    terminalAck(delivery, target, messages, reply)
  );
  expect(result.applied).toBe(true);
  return result;
}

async function setCaps(values: {
  delegation_caps_enabled?: boolean;
  human_gate_enabled?: boolean;
  cycle_cut_enabled?: boolean;
  max_fanout_per_turn?: number;
  max_edge_repeats_per_root?: number;
  max_delegations_per_root?: number;
}): Promise<void> {
  await pool.query(
    `UPDATE agent_chain_policies SET
       delegation_caps_enabled=COALESCE($1,delegation_caps_enabled),
       human_gate_enabled=COALESCE($2,human_gate_enabled),
       cycle_cut_enabled=COALESCE($3,cycle_cut_enabled),
       max_fanout_per_turn=COALESCE($4,max_fanout_per_turn),
       max_edge_repeats_per_root=COALESCE($5,max_edge_repeats_per_root),
       max_delegations_per_root=COALESCE($6,max_delegations_per_root)
     WHERE id='default'`,
    [
      values.delegation_caps_enabled ?? null, values.human_gate_enabled ?? null,
      values.cycle_cut_enabled ?? null, values.max_fanout_per_turn ?? null,
      values.max_edge_repeats_per_root ?? null, values.max_delegations_per_root ?? null
    ]
  );
}

interface MaterializationRow {
  source_alias: string;
  target_alias: string | null;
  status: string;
  rejection_code: string | null;
  hop_count: number;
  rejection_reason: string | null;
  rejection_guidance: string | null;
}

async function materializations(): Promise<MaterializationRow[]> {
  return (await pool.query<MaterializationRow>(
    `SELECT source_alias,target_alias,status,rejection_code,hop_count,
            correlation#>>'{rejection,reason}' AS rejection_reason,
            correlation#>>'{rejection,guidance}' AS rejection_guidance
     FROM agent_output_materializations
     ORDER BY created_at,output_index`
  )).rows;
}

async function deliveriesFor(alias: string): Promise<{ id: string; body_type: string | null }[]> {
  return (await pool.query<{ id: string; body_type: string | null }>(
    `SELECT delivery.id,message.body->>'type' AS body_type
     FROM deliveries delivery JOIN messages message ON message.id=delivery.message_id
     WHERE delivery.recipient_alias=$1 ORDER BY delivery.created_at,delivery.id`,
    [alias]
  )).rows;
}

/**
 * A complete delegation round-trip: the coordinator delegates, the target answers, and the
 * coordinator receives the turn again as an `agent.response` continuation. This is the cycle
 * that accounts for 61% of the traffic measured in prod.
 */
async function delegateAndReturn(
  coordinator: Consumer,
  target: Consumer,
  coordinatorDelivery: DeliveryEnvelope,
  body: string
): Promise<DeliveryEnvelope> {
  await ackWith(coordinator, coordinatorDelivery, [{ to: target.alias, body }]);
  const child = await nextDelivery(target, (item) => item.body.type === 'agent.message');
  await ackWith(target, child, [], 'listo');
  const claimed = await repository.claimDeliveries(
    coordinator.tenant, coordinator.alias, coordinator.instanceId, coordinator.epoch, 10, 30_000
  );
  const response = claimed.find((item) => item.body.type === 'agent.response');
  if (!response) throw new Error(`no agent.response came back to ${coordinator.alias}`);
  return response;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('receipt durable de materialización', () => {
  it('reconstruye feedback idéntico tras commit y replay sin duplicar ramas', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    const ack = terminalAck(root, argos, [
      { to: 'socrates', body: 'primera rama al mismo alias' },
      { to: 'INVALID ALIAS', body: 'esta rama debe rechazarse' },
      { to: 'socrates', body: 'segunda rama al mismo alias' }
    ]);

    const fresh = await repository.ackDelivery(
      root.delivery_id, argos.tenant, argos.alias, ack
    );
    expect(fresh.applied).toBe(true);
    expect(fresh.receipt).toBe('applied');
    expect(fresh.delegation_rejections).toHaveLength(1);
    expect(fresh.delegation_rejections?.[0]).toMatchObject({
      output_index: 1,
      target: 'INVALID ALIAS',
      code: 'unroutable_alias'
    });
    expect(fresh.delegation_materializations?.map((item) => ({
      output_index: item.output_index,
      target_tenant: item.target_tenant,
      target_alias: item.target_alias
    }))).toEqual([
      { output_index: 0, target_tenant: 'Steven', target_alias: 'socrates' },
      { output_index: 2, target_tenant: 'Steven', target_alias: 'socrates' }
    ]);
    expect(new Set(fresh.delegation_materializations?.map(
      (item) => item.child_delivery_id
    )).size).toBe(2);

    // Simulates a crash after the ACK COMMIT and before the adapter processes ack_result: the
    // old connection disappears, the same instance acquires epoch N+1, and only then the event
    // returns through the local outbox. The store must reconstruct equivalent bytes without
    // requiring lease N to still be alive.
    expect(await repository.releaseLease(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch,
    )).toBe(true);
    const epochTwoLease = await repository.acquireLease(
      argos.tenant, argos.alias, argos.instanceId, [], 30_000,
    );
    expect(epochTwoLease).toMatchObject({ acquired: true, epoch: argos.epoch + 1 });
    const replay = await repository.ackDelivery(
      root.delivery_id, argos.tenant, argos.alias, ack
    );
    expect(replay.applied).toBe(false);
    expect(replay.receipt).toBe('duplicate');
    expect(replay.delegation_rejections).toEqual(fresh.delegation_rejections);
    expect(replay.delegation_materializations).toEqual(fresh.delegation_materializations);
    expect(JSON.stringify(replay)).not.toContain('primera rama al mismo alias');
    expect(JSON.stringify(replay)).not.toContain('segunda rama al mismo alias');
    expect((await pool.query(
      `SELECT 1 FROM agent_output_materializations WHERE source_delivery_id=$1`,
      [root.delivery_id]
    )).rowCount).toBe(3);
    expect((await pool.query(
      `SELECT 1 FROM deliveries WHERE id IN (
         SELECT produced_delivery_id FROM agent_output_materializations
         WHERE source_delivery_id=$1 AND status='materialized'
       )`,
      [root.delivery_id]
    )).rowCount).toBe(2);

    // Only the full correlation rebuilds feedback. Every difference, including a new event_id
    // on the same terminal row, returns ownership_lost without adding ACKs or touching the
    // three materializations of the original commit.
    await repository.publish(command());
    const epochTwoArgos: Consumer = { ...argos, epoch: requireValue(epochTwoLease.epoch, 'epochTwoLease.epoch') };
    const otherDelivery = await nextDelivery(epochTwoArgos);
    const before = requireValue((await pool.query<{
      ack_count: string;
      materialization_count: string;
      status: string;
      result: unknown;
    }>(
      `SELECT
         (SELECT count(*) FROM delivery_acks WHERE delivery_id=$1)::text AS ack_count,
         (SELECT count(*) FROM agent_output_materializations WHERE source_delivery_id=$1)::text
           AS materialization_count,
         delivery.status,delivery.result
       FROM deliveries delivery WHERE delivery.id=$1`,
      [root.delivery_id],
    )).rows[0], 'rows');
    const mismatchCases: { name: string; deliveryId: string; candidate: Ack }[] = [
      {
        name: 'event_id',
        deliveryId: root.delivery_id,
        candidate: { ...ack, event_id: randomUUID() },
      },
      {
        name: 'delivery_id',
        deliveryId: otherDelivery.delivery_id,
        candidate: ack,
      },
      {
        name: 'status',
        deliveryId: root.delivery_id,
        candidate: { ...ack, status: 'failed' },
      },
      {
        name: 'instance_id',
        deliveryId: root.delivery_id,
        candidate: { ...ack, instance_id: `other-${randomUUID()}` },
      },
      {
        name: 'epoch',
        deliveryId: root.delivery_id,
        candidate: { ...ack, epoch: ack.epoch + 1 },
      },
      {
        name: 'claim_token',
        deliveryId: root.delivery_id,
        candidate: { ...ack, claim_token: randomUUID() },
      },
      {
        name: 'attempt',
        deliveryId: root.delivery_id,
        candidate: { ...ack, attempt: ack.attempt + 1 },
      },
    ];
    for (const mismatch of mismatchCases) {
      const fenced = await repository.ackDelivery(
        mismatch.deliveryId,
        argos.tenant,
        argos.alias,
        mismatch.candidate,
      );
      expect(fenced, mismatch.name).toMatchObject({
        applied: false,
        receipt: 'ownership_lost',
      });
      expect(fenced, mismatch.name).not.toHaveProperty('delegation_rejections');
      expect(fenced, mismatch.name).not.toHaveProperty('delegation_materializations');
    }
    const after = requireValue((await pool.query<{
      ack_count: string;
      materialization_count: string;
      status: string;
      result: unknown;
    }>(
      `SELECT
         (SELECT count(*) FROM delivery_acks WHERE delivery_id=$1)::text AS ack_count,
         (SELECT count(*) FROM agent_output_materializations WHERE source_delivery_id=$1)::text
           AS materialization_count,
         delivery.status,delivery.result
       FROM deliveries delivery WHERE delivery.id=$1`,
      [root.delivery_id],
    )).rows[0], 'rows');
    expect(after).toEqual(before);
  }, 180_000);

  it('rechaza @all sobre el límite antes de escribir hijos y replays sin truncación', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    interface RoutingTargetForTest { tenant_id: Tenant; alias: string; online: boolean }
    const mutableRepository = repository as unknown as {
      routingTargets(
        client: unknown,
        sourceTenant: Tenant,
        sourceAlias: string,
      ): Promise<RoutingTargetForTest[]>;
    };
    const originalRoutingTargets = mutableRepository.routingTargets.bind(repository);
    mutableRepository.routingTargets = async () => Array.from(
      { length: 1_001 },
      (_, index): RoutingTargetForTest => ({
        tenant_id: 'Steven',
        alias: `peer_${String(index).padStart(4, '0')}`,
        online: true,
      }),
    );
    try {
      const ack = terminalAck(root, argos, [{ to: '@all', body: 'fanout acotado' }]);
      const fresh = await repository.ackDelivery(
        root.delivery_id, argos.tenant, argos.alias, ack,
      );
      expect(fresh).toMatchObject({ applied: true, receipt: 'applied' });
      expect(fresh.delegation_materializations).toBeUndefined();
      expect(fresh.delegation_rejections).toEqual([
        expect.objectContaining({ output_index: 0, target: '@all', code: 'invalid_output' }),
      ]);
      expect((await pool.query(
        `SELECT 1 FROM agent_output_materializations
         WHERE source_delivery_id=$1 AND status='materialized'`,
        [root.delivery_id],
      )).rowCount).toBe(0);
      expect((await pool.query(
        `SELECT 1 FROM agent_output_materializations WHERE source_delivery_id=$1`,
        [root.delivery_id],
      )).rowCount).toBe(1);

      const replay = await repository.ackDelivery(
        root.delivery_id, argos.tenant, argos.alias, ack,
      );
      expect(replay).toEqual({
        delivery_id: root.delivery_id,
        status: 'done',
        applied: false,
        receipt: 'duplicate',
        delegation_rejections: fresh.delegation_rejections,
      });
    } finally {
      mutableRepository.routingTargets = originalRoutingTargets;
    }
  }, 180_000);

  it('falla cerrado si feedback durable legado supera el límite en vez de truncarlo', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    const ack = terminalAck(root, argos, [{ to: 'socrates', body: 'rama original' }]);
    await repository.ackDelivery(root.delivery_id, argos.tenant, argos.alias, ack);
    await pool.query(
      `INSERT INTO agent_output_materializations(
         source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,
         source_alias,target_ref_hash,body_hash,status,rejection_code,request_id,trace_id,
         hop_count,hop_budget,correlation
       )
       SELECT delivery.id,delivery.attempt,series.index,delivery.message_id,message.tenant_id,
              delivery.recipient_alias,repeat('a',64),repeat('b',64),'rejected','invalid_output',
              message.request_id,message.trace_id,1,16,
              jsonb_build_object('rejection',jsonb_build_object(
                'code','invalid_output',
                'reason','legacy feedback exceeds the wire boundary',
                'guidance','split the fanout into bounded batches'
              ))
       FROM deliveries delivery
       JOIN messages message ON message.id=delivery.message_id
       CROSS JOIN generate_series(1,1000) AS series(index)
       WHERE delivery.id=$1`,
      [root.delivery_id],
    );

    await expect(repository.ackDelivery(
      root.delivery_id, argos.tenant, argos.alias, ack,
    )).rejects.toMatchObject({
      name: 'StoreError',
      code: 'conflict',
      message: 'durable delegation feedback exceeds the wire limit',
    });
  }, 180_000);
});

describe('cadena que cicla -> se corta', () => {
  it('corta la rotación por continuación, que NINGUN guarda anterior veía', async () => {
    // This is the dominant failure mode measured in prod, and the one no previous guard touched:
    //
    //   * 61% of delegations are born on an `agent.response` continuation turn. There the target
    //     was never an ANCESTOR of the sender, so `visited_path` does not see it.
    //   * the `actor_alias` guard already blocked the IMMEDIATE repeat, which is why only 129
    //     out of 1411 delegations from the big root repeated the previous target. The walk dodges
    //     that guard by ROTATING: argos sent the same task to kant 148 times, to iza 137, to
    //     kratos 126, to seneca 123... alternating across 12 pairs in a single chain.
    //
    // Counting the (root, sender, target) edge does see it. Here the rotation is reproduced
    // with two pairs and a cap of 1.
    await setCaps({ delegation_caps_enabled: true, max_edge_repeats_per_root: 1 });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());

    const root = await nextDelivery(argos);
    const afterSocrates = await delegateAndReturn(argos, socrates, root, 'vuelta 1');
    // Rotating to another pair sidesteps the immediate-repeat guard: this still goes through, and is fine.
    const afterJarvis = await delegateAndReturn(argos, jarvis, afterSocrates, 'vuelta 2');

    // Returning to socrates is the second time over the SAME edge within the SAME root.
    const third = await ackWith(argos, afterJarvis, [{ to: 'socrates', body: 'vuelta 3' }]);
    const rows = await materializations();
    expect(rows.filter((row) => row.rejection_code === 'edge_repeat_exceeded')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'materialized')).toHaveLength(2);
    expect(third.delegation_rejections?.[0]?.code).toBe('edge_repeat_exceeded');
    // The counter did NOT advance with the rejection: the reservation IS the conditional UPDATE,
    // so a rejection does not consume budget and a retry will not drain it.
    expect((await pool.query<{ uses: number }>(
      `SELECT uses FROM agent_chain_edge_uses WHERE source_node='Steven/argos'
         AND target_node='Steven/socrates'`
    )).rows[0]?.uses).toBe(1);
  }, 180_000);

  it('corta el ciclo por camino de antepasados (A -> B -> C -> A)', async () => {
    // The `actor_alias` guard only blocks the return to the IMMEDIATE parent. Two hops away the
    // cycle was invisible until `visited_path` stopped resetting itself.
    await setCaps({ cycle_cut_enabled: true });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());

    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'trabajo' }]);
    const toSocrates = await nextDelivery(socrates, (item) => item.body.type === 'agent.message');
    await ackWith(socrates, toSocrates, [{ to: 'jarvis', body: 'seguí vos' }]);
    const toJarvis = await nextDelivery(jarvis, (item) => item.body.type === 'agent.message');
    const result = await ackWith(jarvis, toJarvis, [{ to: 'argos', body: 'te lo devuelvo' }]);

    const rows = await materializations();
    expect(rows.map((row) => [row.source_alias, row.target_alias, row.rejection_code])).toEqual([
      ['argos', 'socrates', null],
      ['socrates', 'jarvis', null],
      ['jarvis', null, 'cycle_detected']
    ]);
    expect(result.delegation_rejections?.[0]?.code).toBe('cycle_detected');
  }, 180_000);

  it('acota el abanico del turno INTERNO sin tocar el turno raíz', async () => {
    // The fanout cap exists so the bounded depth is not compensated for in width. The root turn
    // is exempt: in prod, fanouts of 11-14 targets are always `@all` at hop_count=1, and breaking
    // them would kill work that runs today.
    await setCaps({ delegation_caps_enabled: true, max_fanout_per_turn: 1 });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());

    // Root turn (hop_count=1): two targets, both go through.
    await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'rama 1' },
      { to: 'jarvis', body: 'rama 2' }
    ]);
    expect((await materializations()).filter((row) => row.status === 'materialized')).toHaveLength(2);

    // Turno interno (hop_count=2): el segundo destino se rechaza.
    const child = await nextDelivery(socrates, (item) => item.body.type === 'agent.message');
    const result = await ackWith(socrates, child, [
      { to: 'kant', body: 'sub 1' },
      { to: 'jarvis', body: 'sub 2' }
    ]);
    const rejected = (await materializations()).filter(
      (row) => row.rejection_code === 'fanout_exceeded'
    );
    expect(rejected).toHaveLength(1);
    expect(result.delegation_rejections?.[0]?.code).toBe('fanout_exceeded');
  }, 120_000);

  it('agota el combustible de la raíz y deja de emitir', async () => {
    await setCaps({ delegation_caps_enabled: true, max_delegations_per_root: 1 });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());

    const result = await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'una' },
      { to: 'jarvis', body: 'dos' }
    ]);
    const rows = await materializations();
    expect(rows.filter((row) => row.status === 'materialized')).toHaveLength(1);
    expect(rows.filter((row) => row.rejection_code === 'root_budget_exhausted')).toHaveLength(1);
    expect(result.delegation_rejections?.[0]?.code).toBe('root_budget_exhausted');
    expect((await pool.query<{ delegations: number }>(
      'SELECT delegations FROM agent_chain_progress'
    )).rows[0]?.delegations).toBe(1);
  }, 120_000);

  it('con los topes apagados no cambia nada (conducta previa a 019)', async () => {
    // El seguro del despliegue: `delegation_caps_enabled=false` tiene que devolver exactamente
    // la conducta anterior, para que apagar sea una sentencia y no un rollback de imagen.
    await setCaps({
      delegation_caps_enabled: false, max_fanout_per_turn: 1, max_delegations_per_root: 1,
      max_edge_repeats_per_root: 1
    });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());

    const result = await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'una' },
      { to: 'jarvis', body: 'dos' },
      { to: 'kant', body: 'tres' }
    ]);
    expect((await materializations()).filter((row) => row.status === 'materialized')).toHaveLength(3);
    expect(result.delegation_rejections).toBeUndefined();
    expect((await pool.query('SELECT 1 FROM agent_chain_edge_uses')).rowCount).toBe(0);
  }, 120_000);
});

describe('tarea de espera humana -> gate, no entrega', () => {
  it('convierte @human en una fila, suspende la rama y no crea ninguna entrega', async () => {
    await setCaps({ human_gate_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command({ origin: telegramOrigin('chat-gate') }));

    const result = await ackWith(
      argos, await nextDelivery(argos),
      [{ to: '@human', body: '¿Aprobás el gasto de facturación?' }]
    );

    const gates = (await pool.query<{
      id: string; status: string; question: string; asked_by_alias: string;
    }>('SELECT id,status,question,asked_by_alias FROM agent_chain_gates')).rows;
    expect(gates).toHaveLength(1);
    expect(gates[0]?.status).toBe('open');
    expect(gates[0]?.asked_by_alias).toBe('argos');
    expect(result.chain_gate?.gate_id).toBe(gates[0]?.id);

    // NO new delivery was born: it is the opposite of the impossible-to-complete delivery that
    // ended up in dead_letters. The system's only delivery is still the root.
    expect((await pool.query('SELECT 1 FROM deliveries')).rowCount).toBe(1);
    const rows = await materializations();
    expect(rows.map((row) => row.rejection_code)).toEqual(['human_gate_opened']);

    // The branch was SUSPENDED, not terminated: no response was returned upward.
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='agent_output.response'`
    )).rowCount).toBe(0);

    // The question went out ONCE, to the human channel.
    const relays = (await pool.query<{ reply: string; gate_id: string }>(
      `SELECT payload#>>'{result,output,reply}' AS reply,payload->>'gate_id' AS gate_id
       FROM adapter_outbox WHERE kind='origin_relay' AND payload->>'gate_id' IS NOT NULL`
    )).rows;
    expect(relays).toHaveLength(1);
    expect(relays[0]?.reply).toContain('¿Aprobás el gasto de facturación?');
  }, 120_000);

  it('rechaza toda delegación nueva de la raíz mientras el gate esté abierto', async () => {
    await setCaps({ human_gate_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());

    const result = await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'esto no debería salir' },
      { to: '@human', body: '¿seguimos?' }
    ]);

    const rows = await materializations();
    expect(rows.map((row) => row.rejection_code).sort()).toEqual(['chain_gated', 'human_gate_opened']);
    expect((await pool.query('SELECT 1 FROM deliveries')).rowCount).toBe(1);
    const gated = result.delegation_rejections?.find((item) => item.code === 'chain_gated');
    expect(gated?.reason).toContain('¿seguimos?');
  }, 120_000);

  it('con la primitiva apagada, @human vuelve a ser un alias irruteable', async () => {
    await setCaps({ human_gate_enabled: false });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());

    await ackWith(argos, await nextDelivery(argos), [{ to: '@human', body: '¿seguimos?' }]);
    expect((await materializations()).map((row) => row.rejection_code)).toEqual(['unroutable_alias']);
    expect((await pool.query('SELECT 1 FROM agent_chain_gates')).rowCount).toBe(0);
  }, 120_000);
});

describe('gate resuelto -> reanuda', () => {
  it('emite UNA entrega de reanudación al agente que preguntó y libera la cadena', async () => {
    await setCaps({ human_gate_enabled: true, delegation_caps_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: '@human', body: '¿aprobás?' }]);

    const gateId = requireValue((await pool.query<{ id: string }>(
      'SELECT id FROM agent_chain_gates'
    )).rows[0], 'rows').id;

    // The visible list is the counterpart of the gate: without it the wait just changes hiding place.
    const open = await repository.listChainGates('Steven', 'kant');
    expect((open.items as Record<string, unknown>[]).map((item) => item.id)).toEqual([gateId]);

    const answered = await repository.answerChainGate(gateId, 'Sí, aprobado', 'Steven', 'kant');
    expect(answered.recipient_alias).toBe('argos');

    const resumes = (await deliveriesFor('argos')).length;
    expect(resumes).toBe(2); // la raíz + exactamente una reanudación

    const resume = await nextDelivery(argos, (item) => item.body.type === 'agent.message');
    expect(String(resume.body.text)).toContain('Sí, aprobado');
    expect(String(resume.body.text)).toContain('¿aprobás?');

    // The chain accepts delegations again, with its root and budget intact.
    const afterResume = await ackWith(argos, resume, [{ to: 'socrates', body: 'seguimos' }]);
    expect(afterResume.delegation_rejections).toBeUndefined();
    const materialized = (await materializations()).filter((row) => row.status === 'materialized');
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.target_alias).toBe('socrates');
    // The resume did NOT consume a hop: the child of the resumed branch is born at the same hop
    // it would have been born at without a gate.
    expect(materialized[0]?.hop_count).toBe(1);

    const closed = await repository.listChainGates('Steven', 'kant', { status: 'all' });
    expect((closed.items as Record<string, unknown>[])[0]?.status).toBe('answered');
  }, 120_000);

  it('no se puede contestar dos veces el mismo gate', async () => {
    await setCaps({ human_gate_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: '@human', body: '¿aprobás?' }]);
    const gateId = requireValue((await pool.query<{ id: string }>(
      'SELECT id FROM agent_chain_gates'
    )).rows[0], 'rows').id;

    await repository.answerChainGate(gateId, 'sí', 'Steven', 'kant');
    await expect(repository.answerChainGate(gateId, 'sí otra vez', 'Steven', 'kant'))
      .rejects.toMatchObject({ name: 'StoreError', code: 'conflict' });
    expect((await deliveriesFor('argos')).length).toBe(2);
  }, 120_000);

  it('cancelar un gate libera la raíz sin reanudar nada', async () => {
    await setCaps({ human_gate_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: '@human', body: '¿aprobás?' }]);
    const gateId = requireValue((await pool.query<{ id: string }>(
      'SELECT id FROM agent_chain_gates'
    )).rows[0], 'rows').id;

    await repository.cancelChainGate(gateId, 'Steven', 'kant');
    expect((await deliveriesFor('argos')).length).toBe(1);
    await expect(repository.cancelChainGate(gateId, 'Steven', 'kant'))
      .rejects.toBeInstanceOf(StoreError);
  }, 120_000);
});

describe('el rechazo es legible', () => {
  it('deja motivo y qué hacer en la fila durable, en el audit y en la respuesta del ACK', async () => {
    await setCaps({ delegation_caps_enabled: true, max_delegations_per_root: 0 + 1 });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());

    const result = await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'una' },
      { to: 'jarvis', body: 'dos' }
    ]);

    const rejectedRow = (await materializations()).find(
      (row) => row.rejection_code === 'root_budget_exhausted'
    );
    expect(rejectedRow?.rejection_reason).toContain('presupuesto');
    expect(rejectedRow?.rejection_guidance).toEqual(expect.any(String));
    expect(rejectedRow?.rejection_guidance?.length ?? 0).toBeGreaterThan(0);

    const audited = (await pool.query<{ notice: string }>(
      `SELECT metadata->>'rejection_notice' AS notice FROM audit_events
       WHERE action='agent_output.materialize' AND decision='deny'`
    )).rows;
    expect(audited).toHaveLength(1);
    expect(audited[0]?.notice).toContain('presupuesto');

    const rejection = result.delegation_rejections?.[0];
    expect(rejection?.target).toBe('jarvis');
    expect(rejection?.guidance).toEqual(expect.any(String));
    expect(rejection?.guidance.length ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it('omite rechazos vacíos pero informa la materialización exacta del ACK sano', async () => {
    await setCaps({ delegation_caps_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    const result = await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'una' }
    ]);
    expect(result).not.toHaveProperty('delegation_rejections');
    expect(result.delegation_materializations).toEqual([
      expect.objectContaining({
        output_index: 0,
        target_tenant: 'Steven',
        target_alias: 'socrates'
      })
    ]);
    expect(result.delegation_materializations?.[0]?.child_delivery_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
  }, 120_000);
});
