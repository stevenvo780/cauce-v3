import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * El ACK terminal que llega tarde, con la respuesta adentro.
 *
 * Medido sobre producción el 2026-07-29, ventana de 7 días: 495 ACKs 'done' descartados con
 * `applied=false` sobre entregas que terminaron `dead`, y 387 de ellos traían un `reply` NO
 * VACÍO — respuestas reales que el humano nunca vio (argos 250, kratos 23, iza 21, zeus 20,
 * atlas 15). Sólo 2 de los 387 conservaban `claim_token`+`attempt`; en 487 casos el reaper ya
 * había rotado la garra y el bus ya había mandado a ejecutar lo mismo otra vez.
 *
 * La causa era una abstracción equivocada: un único predicado (`exactClaim`) decidía a la vez si
 * el ACK podía modificar la fila y si el RESULTADO valía algo. El plazo es la caducidad de la
 * EXCLUSIVIDAD, no la del resultado.
 *
 * Cada `describe` de acá abajo es uno de los tres casos del análisis: (a) la entrega sigue viva
 * con un intento mayor, (b) ya murió por timeout, (c) ya la contestó otra corrida.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const tenant: Tenant = 'Steven';
const alias = 'argos';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: tenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: tenant, alias }],
    body: { text: 'una pregunta de una persona' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

/** Publica con origen de Telegram, que es lo que hace que exista un relay al humano. */
function humanCommand(conversation: string, overrides: Partial<PublishMessage> = {}): PublishMessage {
  return command({
    authenticated_context: {
      session_id: `telegram-${conversation}`,
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: conversation,
        external_message_id: `msg-${conversation}`,
        relay: [],
        metadata: { bridge_alias: alias, bridge_tenant: tenant }
      }
    },
    ...overrides
  });
}

function ack(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  status: Ack['status'],
  overrides: Partial<Ack> = {}
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    ...overrides
  };
}

function doneAck(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  reply: string,
  overrides: Partial<Ack> = {}
): Ack {
  return ack(delivery, instanceId, epoch, 'done', {
    result: { output: { reply } },
    ...overrides
  });
}

/** Lo que hace el SDK cuando el harness arranca de verdad: sin esto el reaper reintenta. */
async function startExecution(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number
): Promise<void> {
  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias, ack(delivery, instanceId, epoch, 'started')
  );
  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias,
    ack(delivery, instanceId, epoch, 'started', { execution_started: true })
  );
}

async function expire(deliveryId: string): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second',
       claim_expires_at=now()-interval '1 second' WHERE id=$1`,
    [deliveryId]
  );
}

async function deliveryRow(deliveryId: string): Promise<{
  status: string;
  attempt: number;
  reply: string | null;
  last_error: string | null;
  late_result_at: Date | null;
  late_result_attempt: number | null;
}> {
  const result = await pool.query<{
    status: string; attempt: number; reply: string | null; last_error: string | null;
    late_result_at: Date | null; late_result_attempt: number | null;
  }>(
    `SELECT status,attempt,result#>>'{output,reply}' AS reply,last_error,
            late_result_at,late_result_attempt
     FROM deliveries WHERE id=$1`,
    [deliveryId]
  );
  return result.rows[0]!;
}

async function relayRows(deliveryId: string): Promise<Array<{
  idempotency_key: string; status: string; outcome: string | null; reply: string | null;
  late_result: boolean | null;
}>> {
  const result = await pool.query<{
    idempotency_key: string; status: string; outcome: string | null; reply: string | null;
    late_result: boolean | null;
  }>(
    `SELECT idempotency_key,status,payload->>'outcome' AS outcome,
            payload#>>'{result,output,reply}' AS reply,
            (payload->>'late_result')::boolean AS late_result
     FROM adapter_outbox
     WHERE kind='origin_relay' AND delivery_id=$1 AND payload->>'relay_kind' IS DISTINCT FROM 'ack'
     ORDER BY created_at`,
    [deliveryId]
  );
  return result.rows;
}

/**
 * Deja una entrega humana muerta por "ACK timeout: execution already started", que es
 * exactamente el estado en el que quedaron las 387 respuestas perdidas.
 */
async function killByTimeout(conversation: string): Promise<{
  delivery: DeliveryEnvelope; epoch: number; instanceId: string;
}> {
  const instanceId = `assistant-${conversation}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
  await repository.publish(humanCommand(conversation));
  const [delivery] = await repository.claimDeliveries(
    tenant, alias, instanceId, lease.epoch!, 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  await startExecution(delivery, instanceId, lease.epoch!);
  await expire(delivery.delivery_id);
  expect(await repository.retryStaleDeliveries(30_000)).toEqual({ retried: 0, dead: 1, parked: 0 });
  return { delivery, epoch: lease.epoch!, instanceId };
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
});

describe('(b) la entrega ya es dead por timeout y llega el done', () => {
  it('acepta el resultado, revive la entrega y resuelve el dead letter', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-basico');
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');

    const late = doneAck(delivery, instanceId, epoch, 'La respuesta que nadie vio.');
    const result = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);

    expect(result).toMatchObject({ status: 'done', applied: true, receipt: 'applied' });
    const row = await deliveryRow(delivery.delivery_id);
    expect(row.status).toBe('done');
    expect(row.reply).toBe('La respuesta que nadie vio.');
    expect(row.late_result_at).not.toBeNull();
    expect(row.late_result_attempt).toBe(delivery.attempt);

    // El botón de replay del operador no puede ofrecer una entrega ya contestada: eso es una
    // corrida duplicada esperando a que alguien haga clic.
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);

    // El ACK queda registrado como aplicado, no como descarte.
    const stored = await pool.query<{ applied: boolean }>(
      `SELECT applied FROM delivery_acks WHERE event_id=$1`, [late.event_id]
    );
    expect(stored.rows[0]?.applied).toBe(true);

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='delivery.late_result' AND delivery_id=$1`,
      [delivery.delivery_id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      resulting_status: 'done',
      previous_status: 'dead',
      claim_provenance: 'current',
      origin_relay: 'rewritten'
    });
  });

  it('reescribe el aviso de fallo que todavía no salió, para que el humano lea un solo mensaje', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-pendiente');
    const beforeSalvage = await relayRows(delivery.delivery_id);
    expect(beforeSalvage).toHaveLength(1);
    expect(beforeSalvage[0]).toMatchObject({ status: 'pending', outcome: 'dead' });

    await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck(delivery, instanceId, epoch, 'Acá está tu respuesta.')
    );

    const relays = await relayRows(delivery.delivery_id);
    expect(relays).toHaveLength(1);
    expect(relays[0]).toMatchObject({
      idempotency_key: `relay:${delivery.delivery_id}`,
      status: 'pending',
      outcome: 'done',
      late_result: true
    });
    // Sin encabezado de corrección: la persona nunca vio el fallo, no hay nada que corregirle.
    expect(relays[0]?.reply).toBe('Acá está tu respuesta.');
  });

  it('manda un mensaje nuevo y redactado cuando el aviso de fallo YA salió', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-enviado');
    await pool.query(
      `UPDATE adapter_outbox SET status='sent',sent_at=now()
       WHERE kind='origin_relay' AND delivery_id=$1 AND idempotency_key=$2`,
      [delivery.delivery_id, `relay:${delivery.delivery_id}`]
    );

    await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck(delivery, instanceId, epoch, 'Acá está tu respuesta.')
    );

    const relays = await relayRows(delivery.delivery_id);
    expect(relays).toHaveLength(2);
    // El aviso viejo queda intacto: ya lo leyó la persona y reescribirlo sería mentirle al log.
    expect(relays[0]).toMatchObject({ status: 'sent', outcome: 'dead' });
    expect(relays[1]).toMatchObject({
      idempotency_key: `relay-late:${delivery.delivery_id}:${delivery.attempt}`,
      status: 'pending',
      outcome: 'done',
      late_result: true
    });
    expect(relays[1]?.reply).toContain('[respuesta tardía]');
    expect(relays[1]?.reply).toContain('El aviso de fallo anterior queda sin efecto');
    expect(relays[1]?.reply?.endsWith('Acá está tu respuesta.')).toBe(true);
  });

  it('acepta un failed tardío como mejor diagnóstico, sin revivir la entrega', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-failed');

    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, epoch, 'failed', {
        result: { output: { reply: 'Llegué hasta la mitad y me quedé sin cuota.' } },
        error: 'quota exhausted on the weekly window',
        error_code: 'QUOTA_EXHAUSTED'
      })
    );

    expect(result).toMatchObject({ status: 'dead', applied: true, receipt: 'applied' });
    const row = await deliveryRow(delivery.delivery_id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('quota exhausted on the weekly window');
    // El dead letter sigue ABIERTO —sigue siendo un fracaso— pero ahora dice la causa real y no
    // el "ACK timeout" genérico del reaper.
    const letter = await pool.query<{ reason: string; resolved_at: Date | null }>(
      `SELECT reason,resolved_at FROM dead_letters WHERE delivery_id=$1`, [delivery.delivery_id]
    );
    expect(letter.rows[0]?.resolved_at).toBeNull();
    expect(letter.rows[0]?.reason).toBe('quota exhausted on the weekly window');
  });

  it('rescata como mucho una vez por entrega', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-una-sola');
    await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, epoch, 'failed', {
        result: { output: { reply: 'primer tardío' } }, error: 'primera causa'
      })
    );

    const second = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck(delivery, instanceId, epoch, 'segundo tardío')
    );

    expect(second).toMatchObject({ applied: false, receipt: 'ownership_lost', status: 'dead' });
    expect((await deliveryRow(delivery.delivery_id)).reply).toBe('primer tardío');
  });
});

describe('(a) la entrega sigue no terminal, con un intento mayor', () => {
  /**
   * El reaper reintentó (nunca constó ejecución) y el MISMO adaptador se la volvió a llevar.
   * Es el caso realista: hay una sola instancia viva por alias, así que el lease de conexión
   * sigue siendo el mismo y el intento 2 está corriendo cuando llega el 'done' del intento 1.
   */
  async function retriedTwice(conversation: string): Promise<{
    first: DeliveryEnvelope; second: DeliveryEnvelope; epoch: number; instanceId: string;
  }> {
    const instanceId = `assistant-${conversation}`;
    const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
    await repository.publish(humanCommand(conversation));
    const [first] = await repository.claimDeliveries(
      tenant, alias, instanceId, lease.epoch!, 1, 30_000
    );
    if (!first) throw new Error('expected a first claim');
    await repository.ackDelivery(
      first.delivery_id, tenant, alias, ack(first, instanceId, lease.epoch!, 'started')
    );
    await expire(first.delivery_id);
    expect(await repository.retryStaleDeliveries(30_000)).toEqual({ retried: 1, dead: 0, parked: 0 });
    await pool.query(
      `UPDATE deliveries SET available_at=now()-interval '1 second' WHERE id=$1`,
      [first.delivery_id]
    );
    const [second] = await repository.claimDeliveries(
      tenant, alias, instanceId, lease.epoch!, 1, 30_000
    );
    if (!second) throw new Error('expected a second claim');
    expect(second.attempt).toBe(first.attempt + 1);
    return { first, second, epoch: lease.epoch!, instanceId };
  }

  it('acepta el done del intento viejo y deja la corrida nueva sin garra', async () => {
    const { first, second, epoch, instanceId } = await retriedTwice('caso-a');

    const result = await repository.ackDelivery(
      first.delivery_id, tenant, alias,
      doneAck(first, instanceId, epoch, 'terminé, sólo que tarde')
    );

    expect(result).toMatchObject({ status: 'done', applied: true, receipt: 'applied' });
    const row = await deliveryRow(first.delivery_id);
    expect(row.status).toBe('done');
    expect(row.reply).toBe('terminé, sólo que tarde');
    expect(row.late_result_attempt).toBe(first.attempt);

    // Y la corrida en vuelo se entera en su próxima renovación: el SDK aborta el harness con
    // CLAIM_OWNERSHIP_LOST y deja de quemar cuota repitiendo un trabajo ya hecho.
    const renewal = await repository.ackDelivery(
      second.delivery_id, tenant, alias, ack(second, instanceId, epoch, 'started')
    );
    expect(renewal).toMatchObject({ applied: false, receipt: 'ownership_lost' });
  });

  it('la prueba de la garra vieja sale de delivery_acks, no de la fila', async () => {
    const { first, epoch, instanceId } = await retriedTwice('caso-a-procedencia');
    await repository.ackDelivery(
      first.delivery_id, tenant, alias,
      doneAck(first, instanceId, epoch, 'la garra ya había rotado')
    );

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='delivery.late_result' AND delivery_id=$1`,
      [first.delivery_id]
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      // La entrega estaba arrendada al intento 2 cuando llegó el 'done' del intento 1: la
      // procedencia NO pudo salir de la fila (su garra ya era otra) y salió del ACK 'started'
      // aplicado que el intento 1 dejó en `delivery_acks`.
      previous_status: 'leased',
      claim_provenance: 'applied',
      attempt: first.attempt,
      delivery_attempt: first.attempt + 1
    });
  });
});

describe('(c) la entrega ya es done y llega otro done de una corrida vieja', () => {
  it('no pisa el resultado que ya se entregó', async () => {
    const { first, second, epoch, instanceId } = await (async () => {
      const instanceId = 'assistant-caso-c';
      const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
      await repository.publish(humanCommand('caso-c'));
      const [first] = await repository.claimDeliveries(
        tenant, alias, instanceId, lease.epoch!, 1, 30_000
      );
      if (!first) throw new Error('expected a first claim');
      await repository.ackDelivery(
        first.delivery_id, tenant, alias, ack(first, instanceId, lease.epoch!, 'started')
      );
      await expire(first.delivery_id);
      await repository.retryStaleDeliveries(30_000);
      await pool.query(
        `UPDATE deliveries SET available_at=now()-interval '1 second' WHERE id=$1`,
        [first.delivery_id]
      );
      const [second] = await repository.claimDeliveries(
        tenant, alias, instanceId, lease.epoch!, 1, 30_000
      );
      if (!second) throw new Error('expected a second claim');
      return { first, second, epoch: lease.epoch!, instanceId };
    })();

    // La corrida NUEVA contesta primero, dentro de plazo.
    await repository.ackDelivery(
      second.delivery_id, tenant, alias,
      doneAck(second, instanceId, epoch, 'respuesta de la corrida nueva')
    );

    const late = await repository.ackDelivery(
      first.delivery_id, tenant, alias,
      doneAck(first, instanceId, epoch, 'respuesta de la corrida vieja')
    );

    expect(late).toMatchObject({ applied: false, receipt: 'ownership_lost', status: 'done' });
    const row = await deliveryRow(first.delivery_id);
    expect(row.reply).toBe('respuesta de la corrida nueva');
    expect(row.late_result_at).toBeNull();
    // Y el descarte queda registrado, que es lo que permitió medir el agujero en primer lugar.
    expect((await pool.query(
      `SELECT 1 FROM delivery_acks WHERE delivery_id=$1 AND applied=false AND status='done'`,
      [first.delivery_id]
    )).rowCount).toBe(1);
  });

  it('la carrera de dos corridas devolviendo done a la vez la gana una sola', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('carrera');

    // Dos ACKs terminales del mismo intento, con contenidos distintos, lanzados a la vez. El
    // `FOR UPDATE OF d` de `ackDelivery` los serializa: el segundo re-lee la fila ya cerrada.
    const [left, right] = await Promise.all([
      repository.ackDelivery(
        delivery.delivery_id, tenant, alias, doneAck(delivery, instanceId, epoch, 'izquierda')
      ),
      repository.ackDelivery(
        delivery.delivery_id, tenant, alias, doneAck(delivery, instanceId, epoch, 'derecha')
      )
    ]);

    const applied = [left, right].filter((result) => result.applied);
    expect(applied).toHaveLength(1);
    const row = await deliveryRow(delivery.delivery_id);
    expect(row.status).toBe('done');
    expect(['izquierda', 'derecha']).toContain(row.reply);
    // Un solo rescate, un solo aviso al humano.
    expect(await relayRows(delivery.delivery_id)).toHaveLength(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='delivery.late_result' AND delivery_id=$1`,
      [delivery.delivery_id]
    )).rowCount).toBe(1);
  });
});

describe('qué NO se acepta tarde', () => {
  it('un done sin texto: no hay nada que rescatar', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('sin-texto');
    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, epoch, 'done', { result: { output: { reply: '   ' } } })
    );
    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
  });

  it('un done que pide delegar: la ventana de delegación ya pasó', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('con-delegacion');
    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, epoch, 'done', {
        result: {
          output: {
            reply: 'listo, y de paso le pedí algo a kant',
            messages: [{ to: 'kant', body: 'seguí vos' }]
          }
        }
      })
    );
    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
    // Lo importante: NO se creó una entrega nueva para kant.
    expect((await pool.query(
      `SELECT 1 FROM deliveries WHERE recipient_alias='kant'`
    )).rowCount).toBe(0);
  });

  it('un failed tardío sobre una entrega que sigue viva', async () => {
    const instanceId = 'assistant-failed-vivo';
    const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
    await repository.publish(humanCommand('failed-vivo'));
    const [delivery] = await repository.claimDeliveries(
      tenant, alias, instanceId, lease.epoch!, 1, 30_000
    );
    if (!delivery) throw new Error('expected a claimed delivery');
    await repository.ackDelivery(
      delivery.delivery_id, tenant, alias, ack(delivery, instanceId, lease.epoch!, 'started')
    );
    await expire(delivery.delivery_id);
    await repository.retryStaleDeliveries(30_000);

    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, lease.epoch!, 'failed', {
        result: { output: { reply: 'fracasé, pero tarde' } }, error: 'boom'
      })
    );

    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    // Sigue en 'retry': un fracaso viejo no mata un reintento en curso.
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('retry');
  });

  it('un claim_token que nunca existió sobre esta entrega', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('garra-inventada');
    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck({ claim_token: randomUUID(), attempt: delivery.attempt }, instanceId, epoch, 'inventado')
    );
    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
  });

  it('una instancia sin lease de conexión vivo', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('sin-lease');
    await repository.releaseLease(tenant, alias, instanceId, epoch);

    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck(delivery, instanceId, epoch, 'llegué después de desconectarme')
    );

    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
  });

  it('un ACK de un intento que la entrega todavía no alcanzó', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('intento-futuro');
    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck(
        { claim_token: delivery.claim_token, attempt: delivery.attempt + 5 },
        instanceId, epoch, 'del futuro'
      )
    );
    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
  });
});

describe('el mismo evento rechazado y reenviado', () => {
  it('sube de applied=false a applied=true cuando la segunda vuelta sí se rescata', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('reenvio');
    await repository.releaseLease(tenant, alias, instanceId, epoch);
    const late = doneAck(delivery, instanceId, epoch, 'el adaptador no se rindió');

    const rejected = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);
    expect(rejected).toMatchObject({ applied: false, receipt: 'ownership_lost' });

    // El adaptador reconecta con la MISMA identidad (resume) y reenvía el mismo evento.
    const resumed = await repository.acquireLease(
      tenant, alias, instanceId, [], 60_000, { resume: true }
    );
    expect(resumed.epoch).toBe(epoch);
    const accepted = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);

    expect(accepted).toMatchObject({ status: 'done', applied: true, receipt: 'applied' });
    const stored = await pool.query<{ applied: boolean; count: string }>(
      `SELECT applied,count(*)::text AS count FROM delivery_acks
       WHERE event_id=$1 GROUP BY applied`, [late.event_id]
    );
    expect(stored.rows).toEqual([{ applied: true, count: '1' }]);
  });

  it('un evento repetido que ya se había aplicado sigue siendo duplicate', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('duplicado');
    const late = doneAck(delivery, instanceId, epoch, 'una sola vez');
    await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);

    const again = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);
    expect(again).toMatchObject({ applied: false, receipt: 'duplicate', status: 'done' });
    expect(await relayRows(delivery.delivery_id)).toHaveLength(1);
  });
});

describe('la rama de un padre que ya recibió el aviso de fallo', () => {
  it('le manda una respuesta nueva que dice explícitamente que reemplaza al aviso', async () => {
    const parentInstance = 'coordinador';
    const childInstance = 'ejecutor';
    const parentLease = await repository.acquireLease(tenant, alias, parentInstance, [], 60_000);
    await repository.publish(humanCommand('cadena'));
    const [root] = await repository.claimDeliveries(
      tenant, alias, parentInstance, parentLease.epoch!, 1, 30_000
    );
    if (!root) throw new Error('expected the root delivery');
    // argos delega en kant.
    await repository.ackDelivery(
      root.delivery_id, tenant, alias,
      ack(root, parentInstance, parentLease.epoch!, 'done', {
        result: { output: { reply: 'delego', messages: [{ to: 'kant', body: 'hacelo vos' }] } }
      })
    );

    const childLease = await repository.acquireLease(tenant, 'kant', childInstance, [], 60_000);
    const [child] = await repository.claimDeliveries(
      tenant, 'kant', childInstance, childLease.epoch!, 1, 30_000
    );
    if (!child) throw new Error('expected the delegated child delivery');
    await repository.ackDelivery(
      child.delivery_id, tenant, 'kant', ack(child, childInstance, childLease.epoch!, 'started')
    );
    await repository.ackDelivery(
      child.delivery_id, tenant, 'kant',
      ack(child, childInstance, childLease.epoch!, 'started', { execution_started: true })
    );
    await expire(child.delivery_id);
    expect(await repository.retryStaleDeliveries(30_000)).toEqual({ retried: 0, dead: 1, parked: 0 });

    // El padre ya tiene el aviso de fallo en su bandeja.
    const notices = await pool.query<{ text: string; outcome: string }>(
      `SELECT body->>'text' AS text,body->>'outcome' AS outcome FROM messages
       WHERE body->>'type'='agent.response' ORDER BY created_at`
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]?.outcome).toBe('dead');

    const salvaged = await repository.ackDelivery(
      child.delivery_id, tenant, 'kant',
      doneAck(child, childInstance, childLease.epoch!, 'sí lo hice, acá está')
    );
    expect(salvaged).toMatchObject({ status: 'done', applied: true });

    const responses = await pool.query<{
      text: string; outcome: string; late: Record<string, unknown> | null;
    }>(
      `SELECT body->>'text' AS text,body->>'outcome' AS outcome,
              body#>'{correlation,late_result}' AS late
       FROM messages WHERE body->>'type'='agent.response' ORDER BY created_at`
    );
    expect(responses.rows).toHaveLength(2);
    expect(responses.rows[1]?.outcome).toBe('done');
    expect(responses.rows[1]?.text).toContain('[late result]');
    expect(responses.rows[1]?.text).toContain('supersedes the earlier notice');
    expect(responses.rows[1]?.text?.endsWith('sí lo hice, acá está')).toBe(true);
    expect(responses.rows[1]?.late).toMatchObject({ superseded_outcome: 'dead' });

    // Y el rescate de una rama NO manda el relay al humano: el padre es quien cierra la cadena.
    expect(await relayRows(child.delivery_id)).toHaveLength(0);
  });
});
