/**
 * Coalescencia de avisos de fracaso (migración 014).
 *
 * El incidente del 27-jul-2026: un solo mensaje de Telegram produjo 2801 entregas en 35 h y el
 * 84% de la cola de `argos` (223 de 265) eran avisos "X could not complete the delegated
 * request", no trabajo. Cada fracaso de un hijo se materializaba como una entrega NUEVA hacia el
 * padre; el fracaso era su propio combustible.
 *
 * Lo que estos tests fijan no es "se emiten menos mensajes" — eso lo lograría también borrarlos —
 * sino las cuatro cosas juntas: se pliegan, el padre igual se entera, el aviso dice cuántos
 * fueron, y el detalle de cada fracaso sigue estando.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { failureSignature } from '../src/repository.js';
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
    actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
    body: { text: 'coordina esto' },
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

async function claimAll(target: Consumer, limit = 20): Promise<DeliveryEnvelope[]> {
  return repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, limit, 30_000
  );
}

async function nextDelivery(target: Consumer): Promise<DeliveryEnvelope> {
  const claimed = await claimAll(target, 10);
  const delivery = claimed[0];
  if (!delivery) throw new Error(`no delivery for ${target.alias}`);
  return delivery;
}

/** ACK terminal en `done`, con delegaciones. */
async function ackDone(
  target: Consumer, delivery: DeliveryEnvelope, messages: unknown[], reply: string | null = 'listo'
): Promise<void> {
  const ack: Ack = {
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
  const result = await repository.ackDelivery(delivery.delivery_id, target.tenant, target.alias, ack);
  expect(result.applied).toBe(true);
}

/** ACK terminal en `failed` no reintentable: exactamente lo que produce el aviso al padre. */
async function ackFailed(
  target: Consumer, delivery: DeliveryEnvelope, error: string, errorCode: string
): Promise<void> {
  const ack: Ack = {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    error,
    error_code: errorCode
  };
  const result = await repository.ackDelivery(delivery.delivery_id, target.tenant, target.alias, ack);
  expect(result.applied).toBe(true);
  expect(result.status).toBe('failed');
}

async function setCoalescing(enabled: boolean, windowSeconds = 900): Promise<void> {
  await pool.query(
    `UPDATE agent_chain_policies
     SET failure_coalesce_enabled=$1,failure_coalesce_window_seconds=$2 WHERE id='default'`,
    [enabled, windowSeconds]
  );
}

/** Las entregas de aviso que el padre recibiría de verdad: una fila = un mensaje en su cola. */
async function noticesTo(alias: string): Promise<Array<{ text: string; delivery_id: string }>> {
  return (await pool.query<{ text: string; delivery_id: string }>(
    `SELECT message.body->>'text' AS text,delivery.id AS delivery_id
     FROM deliveries delivery
     JOIN messages message ON message.id=delivery.message_id
     WHERE delivery.recipient_alias=$1 AND message.body->>'type'='agent.response'
     ORDER BY message.created_at,delivery.id`,
    [alias]
  )).rows;
}

async function buckets(): Promise<Array<{
  id: string; child_alias: string; failure_signature: string;
  notices_emitted: number; total_failures: number;
}>> {
  return (await pool.query<{
    id: string; child_alias: string; failure_signature: string;
    notices_emitted: number; total_failures: number;
  }>(
    `SELECT id::text AS id,child_alias,failure_signature,notices_emitted,total_failures
     FROM agent_failure_notices ORDER BY id`
  )).rows;
}

/**
 * Escenario del incidente en miniatura: argos manda un pedido a kant, kant abre `branches`
 * ramas hacia socrates, y todas mueren. Todas comparten (padre=kant, hijo=socrates, raíz), que
 * es exactamente la clave de coalescencia.
 */
async function fanoutThatDies(
  branches: number,
  failures: Array<{ error: string; code: string }>
): Promise<{ kant: Consumer; socrates: Consumer; rootMessageId: string }> {
  const kant = await consumer('Steven', 'kant');
  const socrates = await consumer('Steven', 'socrates');
  const published = await repository.publish(command());
  const root = await nextDelivery(kant);
  await ackDone(
    kant, root,
    Array.from({ length: branches }, (_, index) => ({ to: 'socrates', body: `rama ${index}` }))
  );
  const children = await claimAll(socrates, branches);
  expect(children).toHaveLength(branches);
  for (const [index, child] of children.entries()) {
    const failure = failures[index] ?? failures[failures.length - 1]!;
    await ackFailed(socrates, child, failure.error, failure.code);
  }
  return { kant, socrates, rootMessageId: published.message_id };
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

describe('coalescencia de avisos de fracaso', () => {
  const sameCause = [{ error: 'harness exited before producing a reply', code: 'PROCESS_EXIT' }];

  it('pliega cinco fracasos idénticos en UNA sola entrega hacia el padre', async () => {
    await setCoalescing(true);

    await fanoutThatDies(5, sameCause);

    // Lo único que cambia respecto de producción es el número: cinco ramas muertas, cinco avisos.
    const notices = await noticesTo('kant');
    expect(notices).toHaveLength(1);

    const bucket = (await buckets())[0];
    expect(bucket?.child_alias).toBe('socrates');
    expect(bucket?.total_failures).toBe(5);
    expect(bucket?.notices_emitted).toBe(1);
  });

  it('sin coalescencia las mismas cinco muertes producen las cinco entregas del incidente', async () => {
    await setCoalescing(false);

    await fanoutThatDies(5, sameCause);

    expect(await noticesTo('kant')).toHaveLength(5);
    expect(await buckets()).toHaveLength(0);
  });

  it('el aviso que sí llega dice cuántos fracasos representa', async () => {
    await setCoalescing(true);

    await fanoutThatDies(5, sameCause);

    const notice = (await noticesTo('kant'))[0];
    // Sigue empezando con la frase de siempre: un coordinador que la busca no se rompe.
    expect(notice?.text).toContain('socrates could not complete the delegated request');
    // Y ahora además dice lo que el padre no va a ver llegar.
    expect(notice?.text).toContain('5 failures with this same cause from socrates');
    expect(notice?.text).toContain('4 of them were coalesced into this notice instead of being delivered');
    // Y dice dónde está el resto, con el identificador exacto: el aviso no es un callejón.
    expect(notice?.text).toContain('agent_failure_notice_events where notice_id=');
  });

  it('el detalle de cada fracaso plegado sigue siendo recuperable por el padre', async () => {
    await setCoalescing(true);
    await fanoutThatDies(5, sameCause);
    const bucketId = (await buckets())[0]!.id;

    const detail = await repository.failureNoticeDetail(bucketId, 'Steven', 'kant');

    const failures = detail.failures as Array<Record<string, unknown>>;
    // Los cinco fracasos siguen existiendo uno por uno, con su causa cruda.
    expect(failures).toHaveLength(5);
    expect(failures.filter((failure) => failure.coalesced === false)).toHaveLength(1);
    expect(failures.filter((failure) => failure.coalesced === true)).toHaveLength(4);
    expect(failures.every((failure) => failure.error === sameCause[0]!.error)).toBe(true);
    expect(failures.every((failure) => failure.error_code === sameCause[0]!.code)).toBe(true);
    expect(failures.every((failure) => failure.child_alias === 'socrates')).toBe(true);
    // Cada uno nombra la entrega concreta del hijo que murió: se puede ir de acá al replay.
    expect(new Set(failures.map((failure) => failure.child_delivery_id)).size).toBe(5);
    // Y cada uno nombra el aviso bajo el cual el padre lo encuentra.
    expect(new Set(failures.map((failure) => failure.notice_message_id)).size).toBe(1);

    const summary = detail.notice as Record<string, unknown>;
    expect(summary.total_failures).toBe(5);
    expect(summary.notices_emitted).toBe(1);
    expect(summary.child_alias).toBe('socrates');
  });

  it('el detalle es default-deny para quien no es ni el padre ni el hijo', async () => {
    await setCoalescing(true);
    await fanoutThatDies(3, sameCause);
    const bucketId = (await buckets())[0]!.id;

    // `salva` vive en otro tenant no-hub: no puede enumerar cadenas ajenas.
    await expect(repository.failureNoticeDetail(bucketId, 'Isa', 'salva')).rejects.toThrow();
    // El hijo sí puede: es su propio fracaso.
    await expect(repository.failureNoticeDetail(bucketId, 'Steven', 'socrates')).resolves.toBeTruthy();
  });

  it('NO pliega dos causas distintas: un problema nuevo nunca queda detrás de uno viejo', async () => {
    await setCoalescing(true);

    // Misma rama, mismo hijo, misma raíz: sólo cambia el porqué.
    await fanoutThatDies(4, [
      { error: 'harness exited before producing a reply', code: 'PROCESS_EXIT' },
      { error: 'harness exited before producing a reply', code: 'PROCESS_EXIT' },
      { error: 'no credential available for the provider', code: 'AUTH_EXPIRED' },
      { error: 'no credential available for the provider', code: 'AUTH_EXPIRED' }
    ]);

    // Dos causas -> dos cubos -> dos avisos. Cuatro fracasos, no cuatro entregas, pero tampoco
    // una sola que hubiera escondido AUTH_EXPIRED detrás de PROCESS_EXIT.
    const rows = await buckets();
    expect(rows).toHaveLength(2);
    expect(rows.map((bucket) => bucket.total_failures)).toEqual([2, 2]);
    const notices = await noticesTo('kant');
    expect(notices).toHaveLength(2);
    expect(notices.some((notice) => notice.text.includes('harness exited'))).toBe(true);
    expect(notices.some((notice) => notice.text.includes('no credential available'))).toBe(true);
  });

  it('vuelve a emitir cuando la ventana vence, anunciando lo que se plegó en silencio', async () => {
    await setCoalescing(true, 900);
    const kant = await consumer('Steven', 'kant');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(kant);
    // Cinco ramas de la MISMA cadena hacia el MISMO hijo: un solo cubo para las cinco.
    await ackDone(
      kant, root, Array.from({ length: 5 }, (_, index) => ({ to: 'socrates', body: `rama ${index}` }))
    );
    const children = await claimAll(socrates, 5);
    expect(children).toHaveLength(5);

    // Primera ráfaga: 1 aviso + 2 plegados.
    for (const child of children.slice(0, 3)) {
      await ackFailed(socrates, child, sameCause[0]!.error, sameCause[0]!.code);
    }
    expect(await noticesTo('kant')).toHaveLength(1);

    // Envejecer la ventana es la única forma honesta de probar el borde sin dormir 15 minutos:
    // se mueve el reloj del cubo, no el del test.
    await pool.query(`UPDATE agent_failure_notices SET window_expires_at=now()-interval '1 second'`);

    // Segunda ráfaga, ya fuera de la ventana: el padre vuelve a enterarse. Que la tormenta siga
    // ardiendo tiene que llegarle; lo que no puede es llegarle una vez por muerte.
    for (const child of children.slice(3)) {
      await ackFailed(socrates, child, sameCause[0]!.error, sameCause[0]!.code);
    }

    const bucket = (await buckets())[0];
    expect(bucket?.notices_emitted).toBe(2);
    expect(bucket?.total_failures).toBe(5);
    const notices = await noticesTo('kant');
    expect(notices).toHaveLength(2);
    // Contabilidad completa entre los dos avisos: 5 fracasos, 2 entregas, 3 que nunca viajaron
    // solos (el 2.º y el 3.º de la primera ráfaga, y el 5.º de la segunda). Ninguno se perdió.
    expect(notices[0]?.text).toContain('3 failures with this same cause from socrates');
    expect(notices[0]?.text).toContain('2 of them were coalesced into this notice');
    expect(notices[1]?.text).toContain('5 failures with this same cause from socrates');
    expect(notices[1]?.text).toContain('3 of them were coalesced into this notice');
  });

  it('un aviso plegado deja la contabilidad de fan-in intacta', async () => {
    await setCoalescing(true);

    await fanoutThatDies(3, sameCause);

    // materializeAgentFanin cuenta audit_events 'agent_output.response' por child_delivery_id.
    // Si plegar dejara de escribirlos, la cadena esperaría para siempre una respuesta que ya
    // nunca va a llegar: la tormenta de avisos se habría cambiado por un cuelgue silencioso.
    const recorded = await pool.query<{ child_delivery_id: string; coalesced: boolean | null }>(
      `SELECT metadata->>'child_delivery_id' AS child_delivery_id,
              (metadata->>'coalesced')::boolean AS coalesced
       FROM audit_events
       WHERE action='agent_output.response' AND decision='allow' ORDER BY id`
    );
    expect(recorded.rows).toHaveLength(3);
    expect(new Set(recorded.rows.map((row) => row.child_delivery_id)).size).toBe(3);
    expect(recorded.rows.filter((row) => row.coalesced === true)).toHaveLength(2);
  });

  it('nunca pliega una respuesta exitosa', async () => {
    await setCoalescing(true);
    const kant = await consumer('Steven', 'kant');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(command());
    const root = await nextDelivery(kant);
    await ackDone(kant, root, [
      { to: 'socrates', body: 'rama 0' },
      { to: 'socrates', body: 'rama 1' },
      { to: 'socrates', body: 'rama 2' }
    ]);

    for (const child of await claimAll(socrates, 3)) {
      await ackDone(socrates, child, [], 'todo bien');
    }

    expect(await noticesTo('kant')).toHaveLength(3);
    expect(await buckets()).toHaveLength(0);
  });
});

describe('failureSignature', () => {
  it('pliega el mismo fallo reescrito por un contador o un uuid', () => {
    const first = failureSignature(
      'dead', 'ACK timeout on attempt 3 for delivery 6b1c9f2e-9d2a-4c11-9d0a-1a2b3c4d5e6f', undefined
    );
    const second = failureSignature(
      'dead', 'ACK timeout on attempt 11 for delivery 0f9e8d7c-6b5a-4321-8f0e-9d8c7b6a5f4e', undefined
    );
    // Sin este enmascarado la coalescencia no habría plegado NADA en el incidente: cada aviso
    // llevaba un id de entrega distinto.
    expect(first).toBe(second);
  });

  it('separa dos causas distintas y prefiere el código de error al texto', () => {
    expect(failureSignature('failed', 'boom', 'AUTH_EXPIRED'))
      .not.toBe(failureSignature('failed', 'boom', 'PROCESS_EXIT'));
    expect(failureSignature('failed', 'un texto', 'AUTH_EXPIRED'))
      .toBe(failureSignature('failed', 'otro texto totalmente distinto', 'AUTH_EXPIRED'));
  });

  it('distingue el estado terminal aunque la causa no se conozca', () => {
    expect(failureSignature('dead', undefined, undefined)).toBe('dead:unspecified');
    expect(failureSignature('failed', undefined, undefined)).toBe('failed:unspecified');
  });
});
