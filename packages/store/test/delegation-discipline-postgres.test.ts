import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Disciplina de delegación (migración 019).
 *
 * Las tres cosas que el dueño pidió, en el mismo orden:
 *   1. que la cadena que cicla se CORTE, no que se le acabe el presupuesto;
 *   2. que la tarea que espera a una persona deje de ser una entrega imposible;
 *   3. que el rechazo se pueda LEER, para corregir en vez de reintentar.
 */

let database: TestDatabase;
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
  return { tenant, alias, instanceId, epoch: lease.epoch! };
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

async function deliveriesFor(alias: string): Promise<Array<{ id: string; body_type: string | null }>> {
  return (await pool.query<{ id: string; body_type: string | null }>(
    `SELECT delivery.id,message.body->>'type' AS body_type
     FROM deliveries delivery JOIN messages message ON message.id=delivery.message_id
     WHERE delivery.recipient_alias=$1 ORDER BY delivery.created_at,delivery.id`,
    [alias]
  )).rows;
}

/**
 * Un round-trip completo de delegación: el coordinador delega, el destino responde, y el
 * coordinador vuelve a recibir el turno como continuación `agent.response`. Es el ciclo que
 * produce el 61% del tráfico medido en prod.
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

beforeAll(async () => {
  database = await startTestDatabase();
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
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('cadena que cicla -> se corta', () => {
  it('corta la rotación por continuación, que NINGUN guarda anterior veía', async () => {
    // Este es el modo de fallo dominante medido en prod, y el que ningún guarda previo tocaba:
    //
    //   * 61% de las delegaciones nacen sobre un turno de continuación `agent.response`. Ahí el
    //     destino nunca fue ANTEPASADO del emisor, así que `visited_path` no lo ve.
    //   * el guarda de `actor_alias` ya impedía la repetición INMEDIATA, y por eso sólo 129 de
    //     1411 delegaciones de la raíz grande repitieron el destino anterior. El paseo esquiva
    //     ese guarda ROTANDO: argos le mandó el mismo trabajo a kant 148 veces, a iza 137, a
    //     kratos 126, a seneca 123... alternando entre 12 pares en una sola cadena.
    //
    // Contar la arista (raíz, emisor, destino) sí lo ve. Acá se reproduce la rotación con dos
    // pares y un tope de 1.
    await setCaps({ delegation_caps_enabled: true, max_edge_repeats_per_root: 1 });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());

    const root = await nextDelivery(argos);
    const afterSocrates = await delegateAndReturn(argos, socrates, root, 'vuelta 1');
    // Rotar a otro par esquiva el guarda de repetición inmediata: esto hoy sale, y está bien.
    const afterJarvis = await delegateAndReturn(argos, jarvis, afterSocrates, 'vuelta 2');

    // Volver a socrates es la segunda vez sobre la MISMA arista dentro de la MISMA raíz.
    const third = await ackWith(argos, afterJarvis, [{ to: 'socrates', body: 'vuelta 3' }]);
    const rows = await materializations();
    expect(rows.filter((row) => row.rejection_code === 'edge_repeat_exceeded')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'materialized')).toHaveLength(2);
    expect(third.delegation_rejections?.[0]?.code).toBe('edge_repeat_exceeded');
    // El contador NO avanzó con el rechazo: la reserva ES el UPDATE condicional, así que un
    // rechazo no consume presupuesto y un reintento no lo va drenando.
    expect((await pool.query<{ uses: number }>(
      `SELECT uses FROM agent_chain_edge_uses WHERE source_node='Steven/argos'
         AND target_node='Steven/socrates'`
    )).rows[0]?.uses).toBe(1);
  }, 180_000);

  it('corta el ciclo por camino de antepasados (A -> B -> C -> A)', async () => {
    // El guarda de `actor_alias` sólo tapa el retorno al padre INMEDIATO. A dos saltos de
    // distancia el ciclo era invisible hasta que `visited_path` dejó de reiniciarse.
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
    // El tope de abanico existe para que la profundidad acotada no se compense a lo ancho.
    // El turno raíz queda exento: en prod los abanicos de 11-14 destinos son siempre `@all`
    // en hop_count=1, y romperlos mataría trabajo que hoy funciona.
    await setCaps({ delegation_caps_enabled: true, max_fanout_per_turn: 1 });
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());

    // Turno raíz (hop_count=1): dos destinos, los dos salen.
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

    // No nació NINGUNA entrega nueva: es lo contrario de la entrega imposible de completar que
    // terminaba en dead_letters. La única delivery del sistema sigue siendo la raíz.
    expect((await pool.query('SELECT 1 FROM deliveries')).rowCount).toBe(1);
    const rows = await materializations();
    expect(rows.map((row) => row.rejection_code)).toEqual(['human_gate_opened']);

    // La rama quedó SUSPENDIDA, no terminada: no se devolvió respuesta hacia arriba.
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='agent_output.response'`
    )).rowCount).toBe(0);

    // La pregunta salió UNA vez, al canal humano.
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

    const gateId = (await pool.query<{ id: string }>(
      'SELECT id FROM agent_chain_gates'
    )).rows[0]!.id;

    // La lista visible es la contrapartida del gate: sin ella la espera sólo cambia de escondite.
    const open = await repository.listChainGates('Steven', 'kant');
    expect((open.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([gateId]);

    const answered = await repository.answerChainGate(gateId, 'Sí, aprobado', 'Steven', 'kant');
    expect(answered.recipient_alias).toBe('argos');

    const resumes = (await deliveriesFor('argos')).length;
    expect(resumes).toBe(2); // la raíz + exactamente una reanudación

    const resume = await nextDelivery(argos, (item) => item.body.type === 'agent.message');
    expect(String(resume.body.text)).toContain('Sí, aprobado');
    expect(String(resume.body.text)).toContain('¿aprobás?');

    // La cadena vuelve a admitir delegaciones, con su raíz y su presupuesto intactos.
    const afterResume = await ackWith(argos, resume, [{ to: 'socrates', body: 'seguimos' }]);
    expect(afterResume.delegation_rejections).toBeUndefined();
    const materialized = (await materializations()).filter((row) => row.status === 'materialized');
    expect(materialized).toHaveLength(1);
    expect(materialized[0]?.target_alias).toBe('socrates');
    // La reanudación NO consumió un salto: el hijo de la rama reanudada nace al mismo hop que
    // habría nacido sin gate.
    expect(materialized[0]?.hop_count).toBe(1);

    const closed = await repository.listChainGates('Steven', 'kant', { status: 'all' });
    expect((closed.items as Array<Record<string, unknown>>)[0]?.status).toBe('answered');
  }, 120_000);

  it('no se puede contestar dos veces el mismo gate', async () => {
    await setCaps({ human_gate_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: '@human', body: '¿aprobás?' }]);
    const gateId = (await pool.query<{ id: string }>(
      'SELECT id FROM agent_chain_gates'
    )).rows[0]!.id;

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
    const gateId = (await pool.query<{ id: string }>(
      'SELECT id FROM agent_chain_gates'
    )).rows[0]!.id;

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
    expect(rejectedRow?.rejection_guidance).toBeTruthy();

    const audited = (await pool.query<{ notice: string }>(
      `SELECT metadata->>'rejection_notice' AS notice FROM audit_events
       WHERE action='agent_output.materialize' AND decision='deny'`
    )).rows;
    expect(audited).toHaveLength(1);
    expect(audited[0]?.notice).toContain('presupuesto');

    const rejection = result.delegation_rejections?.[0];
    expect(rejection?.target).toBe('jarvis');
    expect(rejection?.guidance).toBeTruthy();
  }, 120_000);

  it('no agrega la clave cuando no hubo ningún rechazo', async () => {
    // Los bytes de la respuesta del ACK no cambian para el 100% de los ACK sanos.
    await setCaps({ delegation_caps_enabled: true });
    const argos = await consumer('Steven', 'argos');
    await repository.publish(command());
    const result = await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'una' }
    ]);
    expect(Object.keys(result).sort()).toEqual(['applied', 'delivery_id', 'receipt', 'status']);
  }, 120_000);
});
