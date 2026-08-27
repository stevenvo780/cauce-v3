import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Barrido de silencio en cadenas de delegación:
 *
 * Garantiza que una tarea iniciada por un humano reciba respuesta incluso si
 * ocurren fallos en ramas delegadas intermedias o si se requiere agregación de fan-in.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

function telegramCommand(conversation: string, overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: `pedido humano ${conversation}` },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    authenticated_context: {
      session_id: `telegram-${conversation}`,
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: conversation,
        external_message_id: conversation,
        relay: [],
        metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
      }
    },
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
    target.tenant, target.alias, target.instanceId, target.epoch, 20, 30_000
  );
  const delivery = claimed.find(predicate);
  if (!delivery) {
    throw new Error(`no matching delivery for ${target.alias}: ${JSON.stringify(
      claimed.map((item) => item.body.type ?? 'request')
    )}`);
  }
  return delivery;
}

async function ackWith(
  target: Consumer,
  delivery: DeliveryEnvelope,
  messages: unknown[] = [],
  reply: string | null = 'listo',
  status: 'done' | 'failed' = 'done'
): Promise<void> {
  const ack: Ack = {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply, messages, status, retryable: false, artifacts: [] } }
  };
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias, ack
  );
  expect(result.applied).toBe(true);
}

/**
 * El padre está muerto: su harness no vuelve, así que la continuación que le tocaba consumir
 * la termina matando el reaper. Es exactamente el estado en el que quedaron las 39 raíces
 * trabadas de producción, y el que hace que NADA vuelva a evaluar la cadena.
 */
async function killOpenDeliveries(
  alias: string,
  reason = 'ACK timeout: max attempts exhausted'
): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET status='dead',terminal_at=now(),updated_at=now(),last_error=$2
     WHERE recipient_alias=$1 AND status NOT IN ('done','failed','dead')`,
    [alias, reason]
  );
}

/** Corre el reloj hacia atrás para que el barrido vea la cadena con la edad que tendría. */
async function ageChain(interval: string): Promise<void> {
  await pool.query(`UPDATE messages SET created_at=created_at-$1::interval`, [interval]);
  await pool.query(
    `UPDATE deliveries SET created_at=created_at-$1::interval,updated_at=updated_at-$1::interval,
       terminal_at=terminal_at-$1::interval`,
    [interval]
  );
  await pool.query(
    `UPDATE agent_output_materializations SET created_at=created_at-$1::interval`, [interval]
  );
  await pool.query(`UPDATE adapter_outbox SET created_at=created_at-$1::interval`, [interval]);
}

interface ClosureNotice {
  idempotency_key: string;
  tenant_id: string;
  adapter: string;
  reply: string;
  outcome: string;
  error_code: string;
  reason: string;
  conversation_id: string;
  root_message_id: string;
  relay_kind: string | null;
}

async function closureNotices(): Promise<ClosureNotice[]> {
  return (await pool.query<ClosureNotice>(
    `SELECT idempotency_key,tenant_id,adapter,
            payload#>>'{result,output,reply}' AS reply,
            payload->>'outcome' AS outcome,
            payload->>'error_code' AS error_code,
            payload#>>'{chain_closure,reason}' AS reason,
            origin->>'conversation_id' AS conversation_id,
            payload#>>'{correlation,root_message_id}' AS root_message_id,
            payload->>'relay_kind' AS relay_kind
     FROM adapter_outbox
     WHERE kind='origin_relay' AND idempotency_key LIKE 'relay-chain-closure:%'
     ORDER BY created_at,id`
  )).rows;
}

/** Respuestas finales que el humano llega a ver, de cualquier origen. */
async function finalRelays(): Promise<number> {
  return (await pool.query(
    `SELECT 1 FROM adapter_outbox
     WHERE kind='origin_relay' AND payload->>'relay_kind' IS DISTINCT FROM 'ack'`
  )).rowCount ?? 0;
}

async function faninMessages(): Promise<number> {
  return (await pool.query(`SELECT 1 FROM messages WHERE body->>'type'='agent.fanin'`)).rowCount ?? 0;
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

/**
 * argos delega en socrates; socrates VUELVE A DELEGAR (disposición `deferred`: nunca escribe
 * `agent_output.response`) y el nieto falla. `responsesRecorded` queda en 1 de 2 para siempre,
 * el fan-in no puede agendarse jamás y no queda ninguna entrega viva capaz de volver a
 * disparar la evaluación. Sin vigía, el humano no se entera nunca.
 */
async function stuckRoot(conversation: string): Promise<string> {
  const argos = await consumer('Steven', 'argos');
  const socrates = await consumer('Steven', 'socrates');
  const jarvis = await consumer('Steven', 'jarvis');
  const published = await repository.publish(telegramCommand(conversation));
  await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'analizá esto' }]);
  await ackWith(socrates, await nextDelivery(socrates), [{ to: 'jarvis', body: 'hacelo vos' }]);
  await ackWith(jarvis, await nextDelivery(jarvis), [], 'no pude', 'failed');
  // argos y socrates están muertos: sus continuaciones nunca se consumen.
  await killOpenDeliveries('socrates');
  await killOpenDeliveries('argos');
  return published.message_id;
}

describe('raíz trabada por el agujero de `deferred`', () => {
  it('vence, avisa al humano una sola vez y no puede volver a avisar', async () => {
    const root = await stuckRoot('chat-trabada');

    // El silencio medido: la cadena entera terminó y el humano no recibió ni una respuesta.
    expect(await finalRelays()).toBe(0);
    // Y no hay nada que pueda cambiarlo: ninguna entrega viva, ningún fan-in agendado.
    expect(await faninMessages()).toBe(0);

    await ageChain('30 minutes');
    const first = await repository.sweepSilentChains();

    expect(first).toMatchObject({ scanned: 1, notified: 1, faninRecovered: 0, skipped: 0 });
    const notices = await closureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      idempotency_key: `relay-chain-closure:${root}`,
      tenant_id: 'Steven',
      adapter: 'telegram',
      outcome: 'failed',
      error_code: 'CHAIN_CLOSED_WITHOUT_ANSWER',
      reason: 'settled_without_fanin',
      conversation_id: 'chat-trabada',
      root_message_id: root,
      // No es un ACK interino: el puente lo manda como relay final y cierra la reacción.
      relay_kind: null
    });
    expect(notices[0]?.reply).toContain('quedó sin respuesta');
    expect(notices[0]?.reply).toContain('2 ramas delegadas');

    // Idempotencia: el barrido corre cada minuto y la raíz sale del conjunto para siempre.
    const second = await repository.sweepSilentChains();
    expect(second).toMatchObject({ scanned: 0, notified: 0 });
    const third = await repository.sweepSilentChains();
    expect(third).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(1);
    expect(await finalRelays()).toBe(1);

    const closure = await pool.query<{ reason: string; branches: number; branches_answered: number }>(
      `SELECT reason,branches,branches_answered FROM agent_chain_closures WHERE root_message_id=$1`,
      [root]
    );
    expect(closure.rows[0]).toMatchObject({
      reason: 'settled_without_fanin', branches: 2, branches_answered: 1
    });
  });

  it('deja rastro auditable del cierre', async () => {
    await stuckRoot('chat-auditoria');
    await ageChain('30 minutes');

    await repository.sweepSilentChains();

    const audit = await pool.query<{ decision: string; outcome: string; reason: string }>(
      `SELECT decision,metadata->>'outcome' AS outcome,metadata->>'reason' AS reason
       FROM audit_events WHERE action='agent_chain.silence_sweep'`
    );
    expect(audit.rows).toEqual([{
      decision: 'info', outcome: 'closed', reason: 'settled_without_fanin'
    }]);
  });

  it('no toca una raíz que todavía no agotó su gracia', async () => {
    await stuckRoot('chat-fresca');

    // Sin envejecer: la gracia de 15 min con la cadena quieta no se cumplió.
    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    await ageChain('14 minutes');
    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);

    // Un minuto más y sí.
    await ageChain('2 minutes');
    expect(await repository.sweepSilentChains()).toMatchObject({ notified: 1 });
  });

  it('respeta la ventana de rastreo: una raíz vieja envejece fuera del barrido', async () => {
    await stuckRoot('chat-vieja');
    await ageChain('5 days');

    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);
  });
});

describe('anti-spam: cien muertes en una raíz son un aviso', () => {
  it('agrega por raíz, con el conteo y la causa dominante en una sola línea', async () => {
    const argos = await consumer('Steven', 'argos');
    const published = await repository.publish(telegramCommand('chat-abanico'));
    const fanout = Array.from({ length: 100 }, (_, index) => ({
      to: index % 2 === 0 ? 'socrates' : 'jarvis',
      body: `rama ${index}`
    }));
    await ackWith(argos, await nextDelivery(argos), fanout);
    expect((await pool.query(
      `SELECT 1 FROM agent_output_materializations WHERE status='materialized'`
    )).rowCount).toBe(100);

    // Las cien mueren. En producción esto pasa de a poco durante horas; el estado final es el
    // mismo y es el que importa: cien muertes, ninguna respuesta, cero avisos.
    await pool.query(
      `UPDATE deliveries SET status='dead',terminal_at=now(),updated_at=now(),
         last_error=CASE WHEN id IN (
           SELECT produced_delivery_id FROM agent_output_materializations
           ORDER BY output_index LIMIT 60
         ) THEN 'ACK timeout: max attempts exhausted' ELSE 'el harness murió' END
       WHERE recipient_alias IN ('socrates','jarvis') AND status NOT IN ('done','failed','dead')`
    );
    await ageChain('30 minutes');

    const swept = await repository.sweepSilentChains();

    expect(swept).toMatchObject({ scanned: 1, notified: 1, faninRecovered: 0 });
    const notices = await closureNotices();
    expect(notices).toHaveLength(1);
    const reply = notices[0]?.reply ?? '';
    expect(reply).toContain('100 ramas delegadas');
    expect(reply).toContain('100 murieron');
    expect(reply).toContain('ACK timeout: max attempts exhausted');
    expect(reply).toContain('(60)');
    // Un aviso agregado tiene que caber en un mensaje, no en cien.
    expect(Buffer.byteLength(reply, 'utf8')).toBeLessThanOrEqual(1_024);
    expect(await finalRelays()).toBe(1);

    const closure = await pool.query<{
      branches: number; branches_dead: number; dominant_cause: string; dominant_cause_count: number;
    }>(
      `SELECT branches,branches_dead,dominant_cause,dominant_cause_count
       FROM agent_chain_closures WHERE root_message_id=$1`,
      [published.message_id]
    );
    expect(closure.rows[0]).toMatchObject({
      branches: 100,
      branches_dead: 100,
      dominant_cause: 'ACK timeout: max attempts exhausted',
      dominant_cause_count: 60
    });
  });

  it('nunca supera el techo de avisos por barrido', async () => {
    const argos = await consumer('Steven', 'argos');
    for (const conversation of ['chat-a', 'chat-b', 'chat-c']) {
      await repository.publish(telegramCommand(conversation));
      await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'algo' }]);
    }
    await killOpenDeliveries('socrates');
    await ageChain('30 minutes');

    const first = await repository.sweepSilentChains({ limit: 2 });
    expect(first).toMatchObject({ scanned: 2, notified: 2 });
    expect(await closureNotices()).toHaveLength(2);

    const second = await repository.sweepSilentChains({ limit: 2 });
    expect(second).toMatchObject({ scanned: 1, notified: 1 });
    expect(await closureNotices()).toHaveLength(3);

    expect(await repository.sweepSilentChains({ limit: 2 })).toMatchObject({ scanned: 0 });
  });
});

describe('la muerte profunda llega al humano sin depender de los padres', () => {
  it('recorre la correlación hasta la raíz y usa su origen, con toda la cadena muerta', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    const seneca = await consumer('Pablo', 'seneca');
    const vulcano = await consumer('Pablo', 'vulcano');
    const published = await repository.publish(telegramCommand('chat-profunda'));

    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'hop 1' }]);
    await ackWith(socrates, await nextDelivery(socrates), [{ to: 'jarvis', body: 'hop 2' }]);
    await ackWith(jarvis, await nextDelivery(jarvis), [{ to: 'seneca', body: 'hop 3' }]);
    await ackWith(seneca, await nextDelivery(seneca), [{ to: 'vulcano', body: 'hop 4' }]);
    const deepest = await nextDelivery(vulcano);
    expect((await pool.query<{ hop_count: number }>(
      `SELECT hop_count FROM agent_output_materializations WHERE produced_delivery_id=$1`,
      [deepest.delivery_id]
    )).rows[0]?.hop_count).toBe(4);

    // El salto 4 muere y NINGÚN padre sigue vivo para propagar la noticia hacia arriba.
    await killOpenDeliveries('vulcano', 'bwrap: No permissions to create a new namespace');
    for (const alias of ['seneca', 'jarvis', 'socrates', 'argos']) await killOpenDeliveries(alias);
    expect(await finalRelays()).toBe(0);
    await ageChain('30 minutes');

    const swept = await repository.sweepSilentChains();

    expect(swept).toMatchObject({ notified: 1 });
    const notices = await closureNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      conversation_id: 'chat-profunda',
      root_message_id: published.message_id
    });
    expect(notices[0]?.reply).toContain('bwrap: No permissions to create a new namespace');
  });
});

describe('destrabar es mejor que avisar', () => {
  it('agenda el fan-in que quedó sin disparador y no manda ningún aviso de fallo', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    const jarvis = await consumer('Steven', 'jarvis');
    await repository.publish(telegramCommand('chat-destrabe'));
    await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'rama 1' },
      { to: 'jarvis', body: 'rama 2' }
    ]);
    await ackWith(socrates, await nextDelivery(socrates), [], 'resultado de socrates');
    await ackWith(jarvis, await nextDelivery(jarvis), [], 'resultado de jarvis');
    // Las dos ramas devolvieron, pero argos está muerto: sus continuaciones se mueren sin
    // consumirse y con eso desaparece el último disparador posible del fan-in.
    expect(await faninMessages()).toBe(0);
    await killOpenDeliveries('argos');
    await ageChain('30 minutes');

    const swept = await repository.sweepSilentChains();

    expect(swept).toMatchObject({ scanned: 1, faninRecovered: 1, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);
    expect(await faninMessages()).toBe(1);
    const audit = await pool.query<{ outcome: string }>(
      `SELECT metadata->>'outcome' AS outcome
       FROM audit_events WHERE action='agent_chain.silence_sweep'`
    );
    expect(audit.rows).toEqual([{ outcome: 'fanin_recovered' }]);
  });
});

/**
 * Recuperación de ramas que alcanzaron estado terminal sin pasar por el flujo de ACK estándar.
 */
describe('la rama incontable: terminal por fuera del ACK', () => {
  /** El UPDATE directo: estado terminal sin ACK, sin auditoría, sin nada. */
  async function terminateOutsideAck(
    alias: string,
    status: 'done' | 'dead',
    error: string | null = null
  ): Promise<void> {
    const updated = await pool.query(
      `UPDATE deliveries child SET status=$2,terminal_at=now(),updated_at=now(),last_error=$3
       FROM agent_output_materializations materialization
       WHERE materialization.produced_delivery_id=child.id
         AND child.recipient_alias=$1 AND child.status NOT IN ('done','failed','dead')`,
      [alias, status, error]
    );
    expect(updated.rowCount).toBe(1);
  }

  async function syntheticResponses(): Promise<{ outcome: string; alias: string }[]> {
    return (await pool.query<{ outcome: string; alias: string }>(
      `SELECT metadata->>'outcome' AS outcome,actor_alias AS alias
       FROM audit_events
       WHERE action='agent_output.response' AND decision='deny'
         AND metadata->>'reason'='terminal_without_response'
       ORDER BY id`
    )).rows;
  }

  /** Lo que el coordinador va a leer de cada rama en el fan-in. */
  async function faninBranchTexts(): Promise<Record<string, string>> {
    const rows = (await pool.query<{ alias: string; text: string }>(
      `SELECT branch->>'alias' AS alias,branch->>'untrusted_text' AS text
       FROM messages,
            jsonb_array_elements(body->'fanin_data_v1'->'responses') branch
       WHERE body->>'type'='agent.fanin'`
    )).rows;
    return Object.fromEntries(rows.map((row) => [row.alias, row.text]));
  }

  /** Una rama contestó de verdad; la otra la terminó a mano un operador. */
  async function chainWithForcedBranch(
    conversation: string,
    status: 'done' | 'dead',
    error: string | null = null
  ): Promise<void> {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(telegramCommand(conversation));
    await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'rama que sí vuelve' },
      { to: 'jarvis', body: 'rama que alguien termina a mano' }
    ]);
    await ackWith(socrates, await nextDelivery(socrates), [], 'resultado de socrates');
    await terminateOutsideAck('jarvis', status, error);
    // El coordinador dejó de consumir: sin esto la cadena tiene trabajo abierto y el vigía ni
    // la mira. Es el estado en el que se descubrió el fallo.
    await killOpenDeliveries('argos');
  }

  it('cuenta la rama terminada a mano y AGENDA el fan-in en vez de avisarle al humano', async () => {
    await chainWithForcedBranch('chat-incontable', 'done');

    // El estado medido: el gate es insatisfacible y no queda nadie que pueda reevaluarlo.
    expect(await faninMessages()).toBe(0);
    expect(await finalRelays()).toBe(0);
    await ageChain('30 minutes');

    const swept = await repository.sweepSilentChains();

    expect(swept).toMatchObject({ scanned: 1, faninRecovered: 1, notified: 0, skipped: 0 });
    expect(await faninMessages()).toBe(1);
    // Al humano NO se le manda ningún aviso de fallo: la respuesta se la va a dar su agente.
    expect(await closureNotices()).toHaveLength(0);
    expect(await syntheticResponses()).toEqual([{ outcome: 'done', alias: 'jarvis' }]);

    // El coordinador recibe las dos ramas: la real con su texto, y la forzada con su desenlace
    // —no con un «Agent response denied» de una respuesta que nadie denegó.
    expect(await faninBranchTexts()).toEqual({
      socrates: 'resultado de socrates',
      jarvis: 'jarvis completed the delegated request without a textual reply.'
    });

    // Idempotencia: la raíz ya tiene fan-in, el vigía no vuelve a tocarla ni duplica la fila.
    expect(await repository.sweepSilentChains()).toMatchObject({ faninRecovered: 0, notified: 0 });
    expect(await faninMessages()).toBe(1);
    expect(await syntheticResponses()).toHaveLength(1);
  });

  it('también cuando la terminaron como muerta, y le pasa la causa real al coordinador', async () => {
    await chainWithForcedBranch('chat-incontable-muerta', 'dead', 'lo maté a mano para destrabar');
    await ageChain('30 minutes');

    expect(await repository.sweepSilentChains()).toMatchObject({ faninRecovered: 1, notified: 0 });

    expect((await faninBranchTexts()).jarvis)
      .toBe('jarvis could not complete the delegated request: lo maté a mano para destrabar');
  });

  /**
   * El caso sano que NO se toca: mientras haya trabajo abierto de verdad, nadie inventa
   * respuestas. Ni cuando la cadena todavía puede avanzar, ni cuando vence por inactividad: el
   * aviso al humano tiene que seguir diciendo cuántas ramas contestaron DE VERDAD.
   */
  it('no rellena nada mientras la cadena tenga trabajo abierto', async () => {
    const argos = await consumer('Steven', 'argos');
    const socrates = await consumer('Steven', 'socrates');
    await repository.publish(telegramCommand('chat-con-trabajo'));
    await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'rama que vuelve' },
      { to: 'jarvis', body: 'rama que sigue trabajando' }
    ]);
    await ackWith(socrates, await nextDelivery(socrates), [], 'resultado de socrates');

    // jarvis sigue con su entrega abierta: manda el plazo largo, no la gracia de 15 min.
    await ageChain('5 hours');
    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await syntheticResponses()).toHaveLength(0);
    expect(await faninMessages()).toBe(0);

    // A las 7 h sin avance se cierra por inactividad, y sigue sin rellenar: el humano lee que
    // contestó UNA rama, que es la verdad.
    await ageChain('2 hours');
    expect(await repository.sweepSilentChains()).toMatchObject({ faninRecovered: 0, notified: 1 });
    expect(await syntheticResponses()).toHaveLength(0);
    expect((await closureNotices())[0]).toMatchObject({ reason: 'idle_timeout' });
    expect((await closureNotices())[0]?.reply).toContain('1 devolvió resultado');

    const closure = await pool.query<{ branches: number; branches_answered: number }>(
      `SELECT branches,branches_answered FROM agent_chain_closures`
    );
    expect(closure.rows[0]).toMatchObject({ branches: 2, branches_answered: 1 });
  });

  /**
   * Y el otro caso sano: si NADA volvió, no hay nada que sintetizar. Rellenar acá cambiaría el
   * aviso agregado con la causa dominante (la garantía P0-4) por un fan-in de ramas vacías.
   */
  it('no rellena una raíz donde ninguna rama devolvió nada', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(telegramCommand('chat-nada-volvio'));
    await ackWith(argos, await nextDelivery(argos), [
      { to: 'socrates', body: 'rama 1' },
      { to: 'jarvis', body: 'rama 2' }
    ]);
    await terminateOutsideAck('socrates', 'dead', 'el harness murió');
    await terminateOutsideAck('jarvis', 'dead', 'el harness murió');
    await killOpenDeliveries('argos');
    await ageChain('30 minutes');

    expect(await repository.sweepSilentChains()).toMatchObject({ faninRecovered: 0, notified: 1 });
    expect(await syntheticResponses()).toHaveLength(0);
    expect(await faninMessages()).toBe(0);
    expect((await closureNotices())[0]?.reply).toContain('el harness murió');
  });
});

describe('lo que el vigía NO debe tocar', () => {
  it('deja en paz una raíz que ya recibió su respuesta final', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(telegramCommand('chat-contestada'));
    await ackWith(argos, await nextDelivery(argos), [], 'acá está tu respuesta');
    expect(await finalRelays()).toBe(1);
    await ageChain('7 hours');

    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);
  });

  it('deja en paz una cadena con trabajo abierto que no llegó al plazo largo', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(telegramCommand('chat-viva'));
    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'todavía trabajando' }]);
    // La rama sigue abierta: manda el plazo de 6 h, no la gracia de 15 min. Un abanico lento
    // no se cierra por impaciencia; el p99 medido de huecos sanos es 4,25 h.
    await ageChain('5 hours');

    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);

    // A las 7 h sin ningún avance sí se cierra, y el motivo lo dice.
    await ageChain('2 hours');
    expect(await repository.sweepSilentChains()).toMatchObject({ notified: 1 });
    expect((await closureNotices())[0]).toMatchObject({ reason: 'idle_timeout' });
    expect((await closureNotices())[0]?.reply).toContain('Sin ningún avance');
  });

  it('no inventa avisos cuando no hay ninguna raíz humana muda', async () => {
    expect(await repository.sweepSilentChains()).toEqual({
      scanned: 0, faninRecovered: 0, notified: 0, skipped: 0
    });
  });
});

describe('cómo se lee el aviso', () => {
  /** Texto fijado a propósito: es lo único que el dueño llega a ver de una tarea muerta. */
  it('es una línea con los conteos, la causa dominante y la raíz para pedir el detalle', async () => {
    const argos = await consumer('Steven', 'argos');
    const published = await repository.publish(telegramCommand('chat-muestra'));
    await ackWith(argos, await nextDelivery(argos), Array.from({ length: 7 }, (_, index) => ({
      to: index % 2 === 0 ? 'socrates' : 'jarvis', body: `rama ${index}`
    })));
    await pool.query(
      `UPDATE deliveries SET status='dead',terminal_at=now(),updated_at=now(),
         last_error='bwrap: No permissions to create a new namespace'
       WHERE recipient_alias IN ('socrates','jarvis') AND status NOT IN ('done','failed','dead')`
    );
    await ageChain('30 minutes');

    await repository.sweepSilentChains();

    expect((await closureNotices())[0]?.reply).toBe(
      '⚠️ Tu pedido quedó sin respuesta: de 7 ramas delegadas, 0 devolvieron resultado, '
      + '7 murieron, 0 fallaron y 0 siguen sin terminar. '
      + 'Causa dominante: «bwrap: No permissions to create a new namespace» (7). '
      + 'La cadena se apagó hace 30 min y ya no puede avanzar sola, así que la cierro acá. '
      + `(raíz ${published.message_id})`
    );
  });

  /**
   * Un `last_error` lo escribe un agente: es texto ajeno que termina en el chat del dueño.
   * Se le quitan los controles y se lo acota, igual que a cualquier salida no confiable.
   */
  it('sanea y acota el diagnóstico que escribió un agente', async () => {
    const argos = await consumer('Steven', 'argos');
    await repository.publish(telegramCommand('chat-sucio'));
    await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'rama' }]);
    await pool.query(
      `UPDATE deliveries SET status='dead',terminal_at=now(),updated_at=now(),last_error=$1
       WHERE recipient_alias='socrates'`,
      [`primera\nsegunda \u200B   tercera ${'x'.repeat(600)}`]
    );
    await ageChain('30 minutes');

    await repository.sweepSilentChains();

    const reply = (await closureNotices())[0]?.reply ?? '';
    expect(reply).toContain('primera segunda tercera');
    expect(reply).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(reply).toContain('…[truncated]');
    expect(Buffer.byteLength(reply, 'utf8')).toBeLessThanOrEqual(1_024);
  });
});
