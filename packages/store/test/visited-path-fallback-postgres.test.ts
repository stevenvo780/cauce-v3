import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

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
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'visited path fallback source' },
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
): Promise<void> {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias,
    terminalAck(delivery, target, messages, reply)
  );
  expect(result.applied).toBe(true);
}

async function setChainPolicy(cycleCutEnabled: boolean): Promise<void> {
  await pool.query(
    `UPDATE agent_chain_policies SET cycle_cut_enabled=$1 WHERE id='default'`,
    [cycleCutEnabled]
  );
}

// `insertAgentOutputRejection` does not write target_tenant/target_alias, so a rejected row has
// them as NULL and must be identified by (source_alias, output_index).
async function materializations(): Promise<{
  source_alias: string;
  target_alias: string | null;
  output_index: number;
  status: string;
  rejection_code: string | null;
  hop_count: number;
  visited_path: string[];
  correlation_visited_path: string[] | null;
}[]> {
  return (await pool.query<{
    source_alias: string;
    target_alias: string | null;
    output_index: number;
    status: string;
    rejection_code: string | null;
    hop_count: number;
    visited_path: string[];
    correlation_visited_path: string[] | null;
  }>(
    `SELECT source_alias,target_alias,output_index,status,rejection_code,hop_count,visited_path,
            CASE WHEN correlation ? 'visited_path'
              THEN ARRAY(SELECT jsonb_array_elements_text(correlation->'visited_path'))
              ELSE NULL END AS correlation_visited_path
     FROM agent_output_materializations
     ORDER BY hop_count,created_at,output_index`
  )).rows;
}

/**
 * Reproduces EXACTLY the row measured in production:
 * `hop_count=N | vp_len=1 | corr_has_hop=t | corr_has_vp=f`.
 *
 * Migration 008 declares `visited_path text[] NOT NULL DEFAULT '{}'`, so every row from before
 * 008 —and every row written during a partial deploy with `visitedPathAvailable=false`— is '{}'
 * rather than NULL. Emptying the column is therefore a faithful simulation of a legacy row, not
 * an invented mutilation; it follows the same technique as the existing test that does
 * `UPDATE agent_output_materializations SET hop_budget=...` to simulate a poisoned durable
 * budget.
 */
async function blankDurableVisitedPath(): Promise<void> {
  await pool.query(`UPDATE agent_output_materializations SET visited_path='{}'`);
}

/** A chain already in flight when this image came in: the body does not carry the field. */
async function stripVisitedPathFromBodies(): Promise<void> {
  await pool.query(
    `UPDATE messages
     SET body=jsonb_set(body,'{correlation}',(body->'correlation') - 'visited_path')
     WHERE body ? 'correlation'`
  );
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
  await pool.end();
  await database.container.stop();
});

// The back edge always points to an alias TWO hops back, never to the immediate emitter: an edge
// toward the immediate emitter is already rejected unconditionally by the ping-pong guard as
// 'unroutable_alias', which would mask 'cycle_detected' and leave the policy untestable. Only a
// revisit further back along the path actually exercises this guard.
describe('respaldo del camino visitado', () => {
  it('escribe el camino visitado en la correlación del cuerpo', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'delegar' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'más profundo' }]);

    // Without this the fallback would have nothing to read: the `corr_has_vp=f` measured in prod.
    expect((await materializations()).map((row) => row.correlation_visited_path)).toEqual([
      ['Steven/argos'],
      ['Steven/argos', 'Steven/socrates']
    ]);
    // And it travels in the message body, which is what the fallback reads in the ACK.
    expect((await nextDelivery(await consumer('Steven', 'jarvis')))
      .body.correlation).toMatchObject({
      visited_path: ['Steven/argos', 'Steven/socrates']
    });
  });

  it('corta el ciclo aunque la fila del padre tenga el camino vacío', async () => {
    await setChainPolicy(true);
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'ir' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'más profundo' }]);

    await blankDurableVisitedPath();

    const grandchild = await nextDelivery(jarvis);
    await ackWith(jarvis, grandchild, [
      { to: 'argos', body: 'borde de vuelta' },
      { to: 'seneca', body: 'hermano legítimo' }
    ]);

    const rows = await materializations();
    // Without the fallback the path resets to ['Steven/jarvis'] (vp_len=1), 'Steven/argos'
    // never appears and this edge gets materialized: the guard is on but BLIND.
    expect(rows.filter((row) => row.status === 'rejected')).toEqual([expect.objectContaining({
      source_alias: 'jarvis',
      output_index: 0,
      rejection_code: 'cycle_detected',
      hop_count: 3
    })]);
    // The legitimate sibling from the SAME batch still passes: the cut is by destination, not by ACK.
    expect(rows.find((row) => row.target_alias === 'seneca')).toMatchObject({
      status: 'materialized'
    });
  });

  it('reconstruye el camino completo en vez de reiniciarlo en largo 1', async () => {
    await setChainPolicy(true);
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'ir' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'más profundo' }]);

    await blankDurableVisitedPath();

    const grandchild = await nextDelivery(jarvis);
    await ackWith(jarvis, grandchild, [{ to: 'seneca', body: 'seguir' }]);

    const seneca = (await materializations()).find((row) => row.target_alias === 'seneca');
    expect(seneca?.visited_path).toEqual(['Steven/argos', 'Steven/socrates', 'Steven/jarvis']);
    expect(seneca?.hop_count).toBe(3);
  });

  it('no corta una cadena larga y sana sin alias repetidos', async () => {
    await setChainPolicy(true);
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const seneca = await consumer('Pablo', 'seneca');
    const midas = await consumer('Pablo', 'midas');
    await repository.publish(command());

    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: '1' }]);
    await ackWith(socrates, await nextDelivery(socrates), [{ to: 'jarvis', body: '2' }]);
    // The inherited path is lost halfway down the chain, as in a legacy row.
    await blankDurableVisitedPath();
    await ackWith(jarvis, await nextDelivery(jarvis), [{ to: 'seneca', body: '3' }]);
    await ackWith(seneca, await nextDelivery(seneca), [{ to: 'midas', body: '4' }]);
    await ackWith(midas, await nextDelivery(midas), [{ to: 'vulcano', body: '5' }]);

    const rows = await materializations();
    expect(rows.filter((row) => row.status === 'rejected')).toEqual([]);
    expect(rows.map((row) => row.target_alias)).toEqual([
      'socrates', 'jarvis', 'seneca', 'midas', 'vulcano'
    ]);
    expect(rows.at(-1)?.visited_path).toEqual([
      'Steven/argos', 'Steven/socrates', 'Steven/jarvis', 'Pablo/seneca', 'Pablo/midas'
    ]);
  });

  // Reusing an alias on another branch is legitimate: path only stores ANCESTORS, never siblings.
  // The reply is sent by jarvis on purpose: delegating back to the one that just replied
  // is blocked by the ping-pong guard as 'unroutable_alias', which would mask cycle detection.
  it('deja al coordinador volver a delegar en un alias que ya usó tras el retorno', async () => {
    await setChainPolicy(true);
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'coordinar' }]);

    // socrates opens two branches and then receives the reply from one of them.
    await ackWith(socrates, await nextDelivery(socrates), [
      { to: 'seneca', body: 'primera vuelta' },
      { to: 'jarvis', body: 'rama hermana' }
    ]);
    await ackWith(jarvis, await nextDelivery(jarvis), [], 'respuesta de la rama hermana');

    await blankDurableVisitedPath();

    const continuation = await nextDelivery(
      socrates, (item) => item.body.type === 'agent.response'
    );
    // Delegates again to seneca, which ALREADY appears in the tree as a sibling branch.
    await ackWith(socrates, continuation, [{ to: 'seneca', body: 'segunda vuelta' }]);

    const rows = await materializations();
    expect(rows.filter((row) => row.rejection_code === 'cycle_detected')).toEqual([]);
    expect(rows.filter((row) => row.target_alias === 'seneca').map((row) => row.status))
      .toEqual(['materialized', 'materialized']);
    // The continuation path is the ancestors of socrates, NOT its sibling branches.
    const second = rows.filter((row) => row.target_alias === 'seneca').at(-1);
    expect(second?.visited_path).toEqual(['Steven/argos', 'Steven/socrates']);
    expect(seneca.alias).toBe('seneca');
  });

  it('degrada a la conducta actual cuando la cadena vieja tampoco lo trae en el cuerpo', async () => {
    await setChainPolicy(true);
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'ir' }]);
    await ackWith(socrates, await nextDelivery(socrates), [{ to: 'jarvis', body: 'más profundo' }]);

    await blankDurableVisitedPath();
    await stripVisitedPathFromBodies();

    await ackWith(jarvis, await nextDelivery(jarvis), [{ to: 'argos', body: 'borde de vuelta' }]);

    // With neither source the guard cannot see the cycle, and does NOT cut. A deploy cannot invent
    // cuts over chains that were already in flight; it heals at the next hop.
    const backEdge = (await materializations())
      .find((row) => row.source_alias === 'jarvis' && row.target_alias === 'argos');
    expect(backEdge).toMatchObject({ status: 'materialized', visited_path: ['Steven/jarvis'] });
  });

  it('no corta nada mientras la política está apagada', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'ir' }]);
    await ackWith(socrates, await nextDelivery(socrates), [{ to: 'jarvis', body: 'más profundo' }]);

    await blankDurableVisitedPath();

    await ackWith(jarvis, await nextDelivery(jarvis), [{ to: 'argos', body: 'borde de vuelta' }]);

    expect((await materializations()).filter((row) => row.status === 'rejected')).toEqual([]);
  });
});
