import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
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
 * El ACK tiene que venir de la MISMA identidad que reclamó la entrega.
 *
 * 🔴 `instance_id` y `epoch` se inventaban aquí (`instance-${randomUUID()}`, `epoch: 1`) y no
 * coincidían con el lease, así que `ackDelivery` los rechaza con «ACK identity does not own this
 * delivery claim». Es el mismo vallado que ya hacía fallar el `claimDeliveries` de más arriba, un
 * paso después: un ACK que no acredita ser quien reclamó podría cerrar el turno de otro.
 *
 * Se pasan como parámetros y no se clavan por lo mismo que el `epoch`: son valores que decide el
 * repositorio, y escribirlos a mano vuelve a atar la prueba a un número que no controla.
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

beforeAll(async () => {
  database = await startTestDatabase();
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
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('materialization across tenant rooms', () => {
  it('should materialize response in correct room when message crosses tenant boundary', async () => {
    // Scenario: Steven sends a message from grp.steven to salva (Isa)
    // salva fails the delegated work
    // materializeAgentResponse should create response in salva's correct room (grp.isa in tenant Isa)
    // NOT in grp.steven (which is Steven's room)

    /*
     * LA DELEGACIÓN SE CREA COMO EN PRODUCCIÓN: por el ACK del padre, no publicándola.
     *
     * Esta prueba publicaba un mensaje suelto de `kant` a `salva` y lo llamaba «delegación». No lo
     * era: sin padre, `materializeAgentResponse` devuelve `'not_child'` y NO escribe ninguna
     * `agent.response`. Medido con una sonda: la consulta del final encontraba CERO filas, así que
     * las tres aserciones sobre la sala —las que dan nombre a la prueba, «que caiga en la de Isa y
     * NO en grp.steven»— vivían dentro de un `if (rows.length > 0)` que nunca se cumplía. Un verde
     * perfecto sobre cero comprobaciones, que es la peor clase de prueba que hay.
     *
     * Tampoco se puede publicar `body.type = 'agent.message'` a mano: es un tipo interno reservado
     * y `publish()` lo rechaza con todo el derecho. La única forma de que exista una delegación es
     * que un agente delegue, así que eso es lo que se hace: `kant` recibe un encargo y su ACK lleva
     * un `messages` hacia `salva`, que está en OTRO inquilino. De ahí sale la entrega cruzada.
     */
    const leaseKant = await repository.acquireLease('Steven', 'kant', 'kant-1', [], 30_000);
    expect(leaseKant.acquired).toBe(true);
    await repository.publish(publishMessageCrossTenant(
      'Steven', 'grp.steven', 'kant', 'Steven', 'kant',
    ));
    const [paraKant] = await repository.claimDeliveries(
      'Steven', 'kant', 'kant-1', leaseKant.epoch!, 1, 30_000,
    );
    expect(paraKant).toBeDefined();
    await repository.ackDelivery(paraKant!.delivery_id, 'Steven', 'kant', {
      version: '3.0',
      event_id: randomUUID(),
      status: 'done',
      instance_id: 'kant-1',
      epoch: leaseKant.epoch!,
      claim_token: paraKant!.claim_token,
      attempt: paraKant!.attempt,
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

    // La entrega que salió de esa delegación, ya en el inquilino de salva.
    const cruzada = await pool.query<{ id: string }>(
      `SELECT d.id FROM deliveries d
       WHERE d.recipient_tenant='Isa' AND d.recipient_alias='salva' ORDER BY d.created_at DESC LIMIT 1`,
    );
    expect(cruzada.rowCount).toBe(1);
    const deliveryId = cruzada.rows[0]!.id;

    /*
     * 🔴 EL LEASE FALTABA, y por eso estas dos pruebas llevaban en rojo.
     *
     * `claimDeliveries` exige un lease de conexión vivo con el MISMO `instance_id` y el MISMO
     * `epoch`, y falla con «delivery claim rejected by lease fencing». Esta prueba reclamaba a
     * pelo con `instance-1` y `epoch 1` inventados, así que sólo podía pasar en una base donde
     * OTRA suite hubiera dejado un lease casualmente compatible — y `resetTestDatabase()` trunca
     * `connection_leases`, así que ni eso.
     *
     * El `epoch` se toma del que devuelve `acquireLease` y no se escribe a mano por lo mismo:
     * clavar un 1 vuelve a atar la prueba a un valor que el repositorio decide.
     */
    const lease = await repository.acquireLease('Isa', 'salva', 'instance-1', [], 30_000);
    expect(lease.acquired).toBe(true);

    // Claim the delivery to salva (Isa)
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'instance-1', lease.epoch!, 1, 30_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.recipient_alias).toBe('salva');

    // salva returns a failed ACK
    const ack = failedAck(claimed[0]!, 'instance-1', lease.epoch!);
    const ackResult = await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack);
    expect(ackResult.applied).toBe(true);

    // Verify the delivery transitioned to 'failed'
    const deliveryAfterAck = await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id = $1',
      [deliveryId]
    );
    expect(deliveryAfterAck.rows[0]!.status).toBe('failed');

    /*
     * El reaper NO tiene nada que hacer aquí, y ésa es la afirmación que vale.
     *
     * Esta prueba exigía `result.dead + result.retried > 0`, o sea que el reaper ENCONTRARA la
     * entrega. Eso sólo podía ser cierto mientras el ACK no llegaba a aplicarse —la prueba no
     * adquiría lease y moría antes, en `claimDeliveries`—. Con el lease y la identidad de ACK
     * correctos, el ACK cierra la entrega en `failed`, que es un estado TERMINAL: el reaper la
     * ignora con todo el derecho.
     *
     * Se invierte la aserción en vez de borrarla porque lo contrario es un invariante que importa:
     * un reaper que volviera a tocar una entrega ya cerrada por su dueño la reintentaría, y el
     * agente pagaría dos veces un trabajo que ya hizo. Envejecerla a mano es justamente la trampa
     * que lo destaparía.
     */
    const pastTime = new Date(Date.now() - 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at = $1, claim_expires_at = $1 WHERE id = $2`,
      [pastTime, deliveryId]
    );

    const result = await repository.retryStaleDeliveries(30_000);
    expect(result.dead + result.retried).toBe(0);

    // Y sigue cerrada donde la dejó el ACK: el reaper no la movió de sitio.
    const trasElReaper = await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id = $1', [deliveryId]
    );
    expect(trasElReaper.rows[0]!.status).toBe('failed');

    // Verify that if a response message was created, it's in the correct room
    const responseMessages = await pool.query<{
      tenant_id: string;
      room_id: string;
      actor_alias: string;
    }>(
      /*
       * El tipo del mensaje vive en `body->>'type'`, NO en una columna `type` — que no existe.
       * Esta consulta llevaba desde siempre reventando con `column "type" does not exist`, tapada
       * por los tres fallos anteriores de esta misma prueba (sin lease, ACK sin identidad, y una
       * aserción sobre el reaper que ya no podía ser cierta). Cada uno escondía al siguiente.
       */
      `SELECT tenant_id, room_id, actor_alias FROM messages
       WHERE body->>'type' = 'agent.response' AND actor_alias = 'salva'`,
      []
    );

    /*
     * SIN `if`. La guarda `if (rows.length > 0)` hacía que la prueba pasara igual sin haber
     * comprobado NADA de lo que su nombre promete. Si algún día deja de materializarse la
     * respuesta, esto tiene que ponerse rojo aquí y no fingir que sigue cubierto.
     */
    expect(responseMessages.rows.length).toBeGreaterThan(0);
    const response = responseMessages.rows[0]!;
    expect(response.tenant_id).toBe('Isa');  // la respuesta vive en el inquilino de salva
    expect(response.actor_alias).toBe('salva');
    // Y en una sala SUYA, nunca en la del que delegó: ése es el defecto que esta prueba persigue.
    expect(response.room_id).not.toBe('grp.steven');
  });

  it('should not crash when recipient membership is missing due to cross-tenant context', async () => {
    // This tests the try/catch defense: even if materialization fails due to
    // missing membership in the computed room, the delivery should still transition
    // to a terminal state without crashing the reaper

    // Arrange: Create a delivery to an agent
    const msg = publishMessageCrossTenant('Steven', 'grp.steven', 'kant', 'Isa', 'salva');
    const published = await repository.publish(msg);
    const deliveryId = published.delivery_ids[0]!;

    // Claim it — con su lease, por lo mismo que la prueba de arriba.
    const lease = await repository.acquireLease('Isa', 'salva', 'instance-1', [], 30_000);
    expect(lease.acquired).toBe(true);
    const claimed = await repository.claimDeliveries('Isa', 'salva', 'instance-1', lease.epoch!, 1, 30_000);
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
    expect(['dead', 'failed', 'done', 'retry']).toContain(finalDelivery.rows[0]!.status);
  });
});
