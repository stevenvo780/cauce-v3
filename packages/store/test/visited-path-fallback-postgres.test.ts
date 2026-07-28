import { randomUUID } from 'node:crypto';
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

// `insertAgentOutputRejection` no escribe target_tenant/target_alias, así que una fila
// rechazada los tiene en NULL y hay que identificarla por (source_alias, output_index).
async function materializations(): Promise<Array<{
  source_alias: string;
  target_alias: string | null;
  output_index: number;
  status: string;
  rejection_code: string | null;
  hop_count: number;
  visited_path: string[];
  correlation_visited_path: string[] | null;
}>> {
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
 * Reproduce EXACTAMENTE la fila que se midió en producción:
 * `hop_count=N | vp_len=1 | corr_has_hop=t | corr_has_vp=f`.
 *
 * Migración 008 declara `visited_path text[] NOT NULL DEFAULT '{}'`, así que toda fila
 * anterior a 008 —y toda fila escrita durante un despliegue parcial con
 * `visitedPathAvailable=false`— vale '{}' sin ser NULL. Vaciar la columna es entonces la
 * simulación fiel de una fila heredada, no una mutilación inventada; sigue la misma técnica
 * que el test ya existente que hace `UPDATE agent_output_materializations SET hop_budget=...`
 * para simular un presupuesto durable envenenado.
 */
async function blankDurableVisitedPath(): Promise<void> {
  await pool.query(`UPDATE agent_output_materializations SET visited_path='{}'`);
}

/** Una cadena que ya estaba en vuelo cuando entró esta imagen: el cuerpo no trae el campo. */
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

// El borde de vuelta apunta siempre a un alias que está DOS saltos atrás, nunca al emisor
// inmediato: un borde hacia el emisor inmediato ya lo rechaza incondicionalmente el guarda de
// ping-pong como 'unroutable_alias', que taparía a 'cycle_detected' y volvería intesteable la
// política. Sólo una revisita más atrás en el camino ejercita este guarda.
describe('respaldo del camino visitado', () => {
  it('escribe el camino visitado en la correlación del cuerpo', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(argos);
    await ackWith(argos, root, [{ to: 'socrates', body: 'delegar' }]);
    const child = await nextDelivery(socrates);
    await ackWith(socrates, child, [{ to: 'jarvis', body: 'más profundo' }]);

    // Sin esto el respaldo no tendría de dónde leer: es el `corr_has_vp=f` medido en prod.
    expect((await materializations()).map((row) => row.correlation_visited_path)).toEqual([
      ['Steven/argos'],
      ['Steven/argos', 'Steven/socrates']
    ]);
    // Y viaja en el cuerpo del mensaje, que es lo que lee el respaldo en el ACK.
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
    // Sin el respaldo el camino se reinicia en ['Steven/jarvis'] (vp_len=1), 'Steven/argos'
    // nunca aparece y este borde se materializa: el guarda está encendido pero CIEGO.
    expect(rows.filter((row) => row.status === 'rejected')).toEqual([expect.objectContaining({
      source_alias: 'jarvis',
      output_index: 0,
      rejection_code: 'cycle_detected',
      hop_count: 3
    })]);
    // El hermano legítimo de la MISMA tanda sigue pasando: el corte es por destino, no por ACK.
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
    // El camino heredado se pierde a mitad de la cadena, como en una fila vieja.
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

  // El falso positivo que más preocupa: un coordinador que delega, recibe el retorno y vuelve
  // a delegar en un alias que YA usó. El camino sólo guarda ANTEPASADOS (la rama que va de la
  // raíz al nodo actual), nunca los hermanos ni los hijos ya cerrados, así que repetir un
  // alias en otra rama es legítimo y no se corta.
  //
  // El retorno lo manda jarvis, no seneca, a propósito: volver a delegar en el que ACABA de
  // responder ya lo bloquea incondicionalmente el guarda de ping-pong como 'unroutable_alias'
  // (`internalAgentDelivery && targetAlias === row.actor_alias`), y eso taparía lo que se
  // quiere medir acá, que es la decisión del guarda de ciclo.
  it('deja al coordinador volver a delegar en un alias que ya usó tras el retorno', async () => {
    await setChainPolicy(true);
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const seneca = await consumer('Pablo', 'seneca');
    await repository.publish(command());
    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'coordinar' }]);

    // socrates abre dos ramas y después recibe el retorno de una de ellas.
    await ackWith(socrates, await nextDelivery(socrates), [
      { to: 'seneca', body: 'primera vuelta' },
      { to: 'jarvis', body: 'rama hermana' }
    ]);
    await ackWith(jarvis, await nextDelivery(jarvis), [], 'respuesta de la rama hermana');

    await blankDurableVisitedPath();

    const continuation = await nextDelivery(
      socrates, (item) => item.body.type === 'agent.response'
    );
    // Vuelve a delegar en seneca, que YA aparece en el árbol como rama hermana.
    await ackWith(socrates, continuation, [{ to: 'seneca', body: 'segunda vuelta' }]);

    const rows = await materializations();
    expect(rows.filter((row) => row.rejection_code === 'cycle_detected')).toEqual([]);
    expect(rows.filter((row) => row.target_alias === 'seneca').map((row) => row.status))
      .toEqual(['materialized', 'materialized']);
    // El camino de la continuación son los antepasados de socrates, NO sus ramas hermanas.
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

    // Sin ninguna de las dos fuentes el guarda no puede ver el ciclo, y NO corta. El despliegue
    // no puede inventar cortes sobre cadenas que ya estaban en vuelo; se cura en el salto nuevo.
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
