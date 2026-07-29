import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY,
  type Ack, type DeliveryEnvelope, type PublishMessage, type Tenant
} from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * The measured failure this file pins down: with every producer writing priority 0, the claim's
 * `(available_at, created_at)` tiebreak IS the policy, so a person's fresh question is served
 * after every machine message the fleet already queued. Over seven days of production, 2.757
 * deliveries sat in front of the owner's 310 Telegram messages and 2.700 of them (97,9%) were
 * agent-to-agent traffic at priority 0 that won on arrival order alone.
 *
 * Two rules together fix it, and BOTH are necessary: a reserved band for the person, and a ceiling
 * that stops that band from being copied onto the work the person's request spawns. Without the
 * ceiling the second request queues behind the fan-out of the first at the same priority and the
 * FIFO tiebreak decides again.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { type: 'telegram.message', text: 'from a person' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: HUMAN_CHAT_PRIORITY,
    authenticated_context: {
      session_id: 'telegram-session',
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: 'priority-band-chat',
        external_message_id: '1',
        relay: [],
        metadata: {}
      }
    },
    ...overrides
  };
}

function terminalAck(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number,
  messages: unknown[],
  reply: string | null = 'done'
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply, messages, status: 'done', retryable: false, artifacts: [] } }
  };
}

async function priorityOf(messageId: string): Promise<number> {
  const row = await pool.query<{ priority: number }>(
    'SELECT priority FROM messages WHERE id=$1', [messageId]
  );
  const priority = row.rows[0]?.priority;
  if (priority === undefined) throw new Error(`message ${messageId} does not exist`);
  return Number(priority);
}

async function lease(tenant: Tenant, alias: string, instanceId: string): Promise<number> {
  const acquired = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  if (acquired.epoch === undefined) throw new Error('expected a connection lease');
  return acquired.epoch;
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  // resetTestDatabase deliberately leaves delivery_lane_fairness alone; the burst tests below
  // depend on starting from a known streak.
  await pool.query('DELETE FROM delivery_lane_fairness');
});

describe('human band ordering', () => {
  it('serves a person ahead of machine traffic that has been queued for longer', async () => {
    const instanceId = 'ordering-consumer';
    const epoch = await lease('Steven', 'argos', instanceId);

    // Three agent-band messages first, so arrival order alone would put the person last.
    for (let index = 0; index < 3; index += 1) {
      await repository.publish(command({
        body: { type: 'adapter.work', text: `machine ${index}` },
        priority: AGENT_PRIORITY_CEILING,
        authenticated_context: { session_id: `machine-${index}`, channel: 'adapter' }
      }));
    }
    const person = await repository.publish(command({ body: { type: 'telegram.message', text: 'the owner' } }));

    const [first] = await repository.claimDeliveries('Steven', 'argos', instanceId, epoch, 1, 30_000);
    expect(first?.message_id).toBe(person.message_id);
    expect(first?.body).toMatchObject({ type: 'telegram.message', text: 'the owner' });
  });

  it('keeps arrival order among people, so nobody jumps a queue of their peers', async () => {
    const instanceId = 'peer-consumer';
    const epoch = await lease('Steven', 'argos', instanceId);
    const first = await repository.publish(command({ body: { type: 'telegram.message', text: 'first person' } }));
    const second = await repository.publish(command({ body: { type: 'telegram.message', text: 'second person' } }));

    const claimed = await repository.claimDeliveries('Steven', 'argos', instanceId, epoch, 2, 30_000);
    expect(claimed.map((delivery) => delivery.message_id)).toEqual([first.message_id, second.message_id]);
  });
});

describe('agent band ceiling on materialized output', () => {
  it('does not let a human priority propagate into the work the request spawns', async () => {
    const consumerInstance = 'chain-argos';
    const targetInstance = 'chain-kant';
    const consumerEpoch = await lease('Steven', 'argos', consumerInstance);

    const root = await repository.publish(command());
    const [rootDelivery] = await repository.claimDeliveries(
      'Steven', 'argos', consumerInstance, consumerEpoch, 1, 30_000
    );
    if (!rootDelivery) throw new Error('expected the root delivery');
    expect(await priorityOf(root.message_id)).toBe(HUMAN_CHAT_PRIORITY);

    // argos delegates to kant. The child inherits the lane and the origin, never the band.
    await repository.ackDelivery(
      rootDelivery.delivery_id, 'Steven', 'argos',
      terminalAck(rootDelivery, consumerInstance, consumerEpoch, [{ to: 'kant', body: 'delegated work' }])
    );

    const targetEpoch = await lease('Steven', 'kant', targetInstance);
    const [child] = await repository.claimDeliveries(
      'Steven', 'kant', targetInstance, targetEpoch, 1, 30_000
    );
    if (!child) throw new Error('expected the delegated delivery');
    expect(child.body).toMatchObject({ type: 'agent.message', text: 'delegated work' });
    expect(await priorityOf(child.message_id)).toBe(AGENT_PRIORITY_CEILING);

    // kant answers. The response back to argos is the largest class in the real queue and is held
    // in the agent band too.
    await repository.ackDelivery(
      child.delivery_id, 'Steven', 'kant',
      terminalAck(child, targetInstance, targetEpoch, [])
    );
    const [response] = await repository.claimDeliveries(
      'Steven', 'argos', consumerInstance, consumerEpoch, 1, 30_000
    );
    if (!response) throw new Error('expected the agent response');
    expect(response.body).toMatchObject({ type: 'agent.response', from_alias: 'kant' });
    expect(await priorityOf(response.message_id)).toBe(AGENT_PRIORITY_CEILING);

    // The fan-in is the exception, and it is the one message the person is still waiting for:
    // it wakes the coordinator to write the answer. There is exactly one per root, so it cannot
    // amplify.
    await repository.ackDelivery(
      response.delivery_id, 'Steven', 'argos',
      terminalAck(response, consumerInstance, consumerEpoch, [])
    );
    const claimed = await repository.claimDeliveries(
      'Steven', 'argos', consumerInstance, consumerEpoch, 10, 30_000
    );
    const fanin = claimed.find((delivery) => delivery.body.type === 'agent.fanin');
    if (!fanin) {
      throw new Error(`expected a fan-in delivery, received ${JSON.stringify(
        claimed.map((delivery) => delivery.body.type)
      )}`);
    }
    expect(await priorityOf(fanin.message_id)).toBe(HUMAN_CHAT_PRIORITY);
  });

  it('holds a nested delegation in the agent band all the way down', async () => {
    const argosInstance = 'nested-argos';
    const kantInstance = 'nested-kant';
    const argosEpoch = await lease('Steven', 'argos', argosInstance);

    await repository.publish(command());
    const [rootDelivery] = await repository.claimDeliveries(
      'Steven', 'argos', argosInstance, argosEpoch, 1, 30_000
    );
    if (!rootDelivery) throw new Error('expected the root delivery');
    await repository.ackDelivery(
      rootDelivery.delivery_id, 'Steven', 'argos',
      terminalAck(rootDelivery, argosInstance, argosEpoch, [{ to: 'kant', body: 'first hop' }])
    );

    const kantEpoch = await lease('Steven', 'kant', kantInstance);
    const [child] = await repository.claimDeliveries(
      'Steven', 'kant', kantInstance, kantEpoch, 1, 30_000
    );
    if (!child) throw new Error('expected the first hop');
    await repository.ackDelivery(
      child.delivery_id, 'Steven', 'kant',
      terminalAck(child, kantInstance, kantEpoch, [{ to: 'jarvis', body: 'second hop' }])
    );

    const jarvisInstance = 'nested-jarvis';
    const jarvisEpoch = await lease('Steven', 'jarvis', jarvisInstance);
    const [grandchild] = await repository.claimDeliveries(
      'Steven', 'jarvis', jarvisInstance, jarvisEpoch, 1, 30_000
    );
    if (!grandchild) throw new Error('expected the second hop');
    expect(await priorityOf(grandchild.message_id)).toBe(AGENT_PRIORITY_CEILING);
  });
});

describe('lane fairness burst', () => {
  async function seedInteractive(alias: string, priority: number, text: string): Promise<void> {
    await repository.publish(command({
      recipients: [{ tenant_id: 'Steven', alias }],
      body: { type: 'telegram.message', text },
      priority
    }));
  }

  /**
   * Escribe una entrega agente-a-agente igual que `materializeAgentOutputs`: mismo `body.type` y
   * mismo `lane='batch'`. Va por INSERT directo porque `publish()` rechaza los tipos reservados
   * a propósito — un cliente no puede fabricar tráfico entre agentes.
   */
  async function seedAgentToAgent(alias: string, text: string): Promise<void> {
    const message = await pool.query<{ id: string }>(
      `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
       VALUES($1,$2,'Steven','grp.steven','argos',$3::jsonb,'batch',0) RETURNING id`,
      [randomUUID(), `trace-${randomUUID()}`, JSON.stringify({
        type: 'agent.message', text, from_alias: 'argos'
      })]
    );
    await pool.query(
      `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,'Steven',$2)`,
      [message.rows[0]!.id, alias]
    );
  }

  async function seedBatch(alias: string, text: string): Promise<void> {
    await repository.publish(command({
      recipients: [{ tenant_id: 'Steven', alias }],
      body: { type: 'adapter.work', text },
      lane: 'batch',
      priority: 0,
      authenticated_context: { session_id: `batch-${text}`, channel: 'adapter' }
    }));
  }

  /**
   * INTEGRACIÓN 2026-07-29 — este test cambió de forma porque cambió el mecanismo, no el
   * objetivo. Nació contra la equidad POR CARRIL (`interactive_streak` contaba reclamos del
   * carril 'interactive' y cada `interactiveBurst` le cedía un turno a 'batch'). La línea que se
   * integra reemplazó esa partición por la clasificación HUMANO / AGENTE-A-AGENTE, porque el
   * carril se heredaba literal en cada salto y una cadena de agentes entera viajaba en
   * 'interactive' junto con los mensajes de las personas (2.374 de 2.429 entregas medidas).
   *
   * Con eso, "tráfico de máquinas esperando en el carril interactivo" ya no se escribe con un
   * `telegram.message` de prioridad 0 —eso es clase HUMANA para el clasificador— sino con un
   * `agent.message`, que además desde esta misma integración nace en 'batch'.
   *
   * Lo que se sigue probando es lo mismo que antes: **el trabajo entre agentes no se muere de
   * hambre**. Sólo que ahora quien le cede el turno es la ráfaga HUMANA (`humanBurst`), no la de
   * carril. Si alguien borrara el `yieldTurn` de `claimDeliveries`, este test se pondría rojo.
   */
  it('gives agent-to-agent work its turn once the human burst is spent', async () => {
    const instanceId = 'burst-control';
    const epoch = await lease('Steven', 'kant', instanceId);
    await seedInteractive('kant', HUMAN_CHAT_PRIORITY, 'person one');
    await seedInteractive('kant', HUMAN_CHAT_PRIORITY, 'person two');
    await seedAgentToAgent('kant', 'agent work');

    // humanBurst=1: servida una persona, el segundo reclamo de la llamada cede el turno.
    const claimed = await repository.claimDeliveries('Steven', 'kant', instanceId, epoch, 2, 30_000, 1);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['person one', 'agent work']);
  });

  it('does not spend the batch turn while a person is waiting', async () => {
    const instanceId = 'burst-human';
    const epoch = await lease('Steven', 'jarvis', instanceId);
    await seedInteractive('jarvis', HUMAN_CHAT_PRIORITY, 'person one');
    await seedInteractive('jarvis', HUMAN_CHAT_PRIORITY, 'person two');
    await seedBatch('jarvis', 'background');

    const claimed = await repository.claimDeliveries('Steven', 'jarvis', instanceId, epoch, 2, 30_000, 1);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['person one', 'person two']);
  });

  it('returns the batch turn as soon as the person queue drains', async () => {
    const instanceId = 'burst-drain';
    const epoch = await lease('Steven', 'socrates', instanceId);
    await seedInteractive('socrates', HUMAN_CHAT_PRIORITY, 'person one');
    await seedBatch('socrates', 'background');

    // The person is served first, and the batch turn is not lost: it is taken on the next
    // iteration, once nothing in the human band is pending any more.
    const claimed = await repository.claimDeliveries('Steven', 'socrates', instanceId, epoch, 2, 30_000, 1);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['person one', 'background']);
  });
});
