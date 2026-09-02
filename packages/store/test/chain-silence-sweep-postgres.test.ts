import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  ackWith as applyTerminalAck, consumer as leaseConsumer, nextDelivery as claimNext,
  type Consumer
} from './helpers/consumer.js';

/**
 * Silence sweep in delegation chains: ensures a task started by a human receives a reply even when intermediate
 * delegated branches fail or when fan-in aggregation is required.
 */

let database: TestDatabase;
let databaseStarted = false;
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

const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias);

const nextDelivery = (
  target: Consumer, predicate?: (delivery: DeliveryEnvelope) => boolean
): Promise<DeliveryEnvelope> => claimNext(repository, target, predicate, 20);

const ackWith = async (
  target: Consumer, delivery: DeliveryEnvelope, messages: unknown[] = [],
  reply: string | null = 'listo', status: 'done' | 'failed' = 'done'
): Promise<void> => {
  await applyTerminalAck(repository, target, delivery, { messages, reply, status });
};

/**
 * The parent is dead: its harness does not return, so the continuation it was supposed to consume is finished off by
 * the reaper. This is exactly the state the 39 stuck roots from production were left in, and what makes NOTHING
 * re-evaluate the chain.
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

/** Runs the clock backwards so the sweep sees the chain with the age it would have. */
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

/** Final replies the human gets to see, from any origin. */
async function finalRelays(): Promise<number> {
  return (await pool.query(
    `SELECT 1 FROM adapter_outbox
     WHERE kind='origin_relay' AND payload->>'relay_kind' IS DISTINCT FROM 'ack'`
  )).rowCount ?? 0;
}

async function faninMessages(): Promise<number> {
  return (await pool.query(`SELECT 1 FROM messages WHERE body->>'type'='agent.fanin'`)).rowCount ?? 0;
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

/**
 * argos delegates to socrates; socrates DELEGATES AGAIN (disposition `deferred`: never writes `agent_output.response`)
 * and the grandchild fails. `responsesRecorded` stays at 1 of 2 forever, the fan-in can never be scheduled, and no
 * live delivery remains that could re-trigger the evaluation. Without a watchdog, the human never finds out.
 */
async function stuckRoot(conversation: string): Promise<string> {
  const argos = await consumer('Steven', 'argos');
  const socrates = await consumer('Steven', 'socrates');
  const jarvis = await consumer('Steven', 'jarvis');
  const published = await repository.publish(telegramCommand(conversation));
  await ackWith(argos, await nextDelivery(argos), [{ to: 'socrates', body: 'analizá esto' }]);
  await ackWith(socrates, await nextDelivery(socrates), [{ to: 'jarvis', body: 'hacelo vos' }]);
  await ackWith(jarvis, await nextDelivery(jarvis), [], 'no pude', 'failed');
  // argos and socrates are dead: their continuations are never consumed.
  await killOpenDeliveries('socrates');
  await killOpenDeliveries('argos');
  return published.message_id;
}

describe('raíz trabada por el agujero de `deferred`', () => {
  it('vence, avisa al humano una sola vez y no puede volver a avisar', async () => {
    const root = await stuckRoot('chat-trabada');

    // The measured silence: the whole chain ended and the human received not a single reply.
    expect(await finalRelays()).toBe(0);
    // And nothing can change that: no live delivery, no scheduled fan-in.
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
      // Not an interim ACK: the bridge sends it as the final relay and closes the reaction.
      relay_kind: null
    });
    expect(notices[0]?.reply).toContain('quedó sin respuesta');
    expect(notices[0]?.reply).toContain('2 ramas delegadas');

    // Idempotency: the sweep runs every minute, and the root leaves the set forever.
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

    // Without aging: the 15-minute grace with the chain quiet was not met.
    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    await ageChain('14 minutes');
    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);

    // One more minute and yes.
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
      body: `rama ${String(index)}`
    }));
    await ackWith(argos, await nextDelivery(argos), fanout);
    expect((await pool.query(
      `SELECT 1 FROM agent_output_materializations WHERE status='materialized'`
    )).rowCount).toBe(100);

    // The hundred die. In production this happens slowly over hours; the final state is the
    // same and is what matters: a hundred deaths, no reply, zero notices.
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
    // An aggregated notice must fit in a single message, not a hundred.
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

    // Hop 4 dies and NO parent remains alive to propagate the news upward.
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
    // Both branches returned, but argos is dead: its continuations die without being consumed
    // and with them the last possible trigger of the fan-in disappears.
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
 * Recovery of branches that reached a terminal state without going through the standard ACK flow.
 */
describe('la rama incontable: terminal por fuera del ACK', () => {
  /** The direct UPDATE: terminal state without ACK, without audit, without anything. */
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

  /** What the coordinator will read from each branch in the fan-in. */
  async function faninBranchTexts(): Promise<Record<string, string>> {
    const rows = (await pool.query<{ alias: string; text: string }>(
      `SELECT branch->>'alias' AS alias,branch->>'untrusted_text' AS text
       FROM messages,
            jsonb_array_elements(body->'fanin_data_v1'->'responses') branch
       WHERE body->>'type'='agent.fanin'`
    )).rows;
    return Object.fromEntries(rows.map((row) => [row.alias, row.text]));
  }

  /** One branch actually replied; the other was terminated by hand by an operator. */
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
    // The coordinator stopped consuming: without this the chain has open work and the watchdog
    // does not even look at it. This is the state in which the bug was discovered.
    await killOpenDeliveries('argos');
  }

  it('cuenta la rama terminada a mano y AGENDA el fan-in en vez de avisarle al humano', async () => {
    await chainWithForcedBranch('chat-incontable', 'done');

    // The measured state: the gate is unsatisfiable and no one remains who can re-evaluate it.
    expect(await faninMessages()).toBe(0);
    expect(await finalRelays()).toBe(0);
    await ageChain('30 minutes');

    const swept = await repository.sweepSilentChains();

    expect(swept).toMatchObject({ scanned: 1, faninRecovered: 1, notified: 0, skipped: 0 });
    expect(await faninMessages()).toBe(1);
    // NO failure notice is sent to the human: their agent is the one that will give them the
    // reply.
    expect(await closureNotices()).toHaveLength(0);
    expect(await syntheticResponses()).toEqual([{ outcome: 'done', alias: 'jarvis' }]);

    // The coordinator receives both branches: the real one with its text, and the forced one
    // with its outcome — not with an "Agent response denied" from a reply no one denied.
    expect(await faninBranchTexts()).toEqual({
      socrates: 'resultado de socrates',
      jarvis: 'jarvis completed the delegated request without a textual reply.'
    });

    // Idempotency: the root already has fan-in, the watchdog does not touch it again or
    // duplicate the row.
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
   * The healthy case that is NOT touched: while there is real open work, nobody invents replies. Not when
   * the chain can still advance, not when it expires from inactivity: the notice to the human must keep
   * reporting how many branches actually replied.
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

    // jarvis still has its delivery open: the long deadline applies, not the 15-minute grace.
    await ageChain('5 hours');
    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await syntheticResponses()).toHaveLength(0);
    expect(await faninMessages()).toBe(0);

    // At 7 h with no progress it closes for inactivity, and still without filling anything: the
    // human reads that ONE branch replied, which is the truth.
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
   * And the other healthy case: if NOTHING came back, there is nothing to synthesize. Filling
   * in here would swap the aggregated notice with the dominant cause (the P0-4 guarantee) for
   * a fan-in of empty branches.
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
    // The branch is still open: the 6-hour deadline applies, not the 15-minute grace. A slow
    // fan-out is not closed out of impatience; the measured p99 of healthy gaps is 4.25 h.
    await ageChain('5 hours');

    expect(await repository.sweepSilentChains()).toMatchObject({ scanned: 0, notified: 0 });
    expect(await closureNotices()).toHaveLength(0);

    // At 7 h with no progress at all it does close, and the reason says so.
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
  /** Text fixed on purpose: it is the only thing the owner ever sees of a dead task. */
  it('es una línea con los conteos, la causa dominante y la raíz para pedir el detalle', async () => {
    const argos = await consumer('Steven', 'argos');
    const published = await repository.publish(telegramCommand('chat-muestra'));
    await ackWith(argos, await nextDelivery(argos), Array.from({ length: 7 }, (_, index) => ({
      to: index % 2 === 0 ? 'socrates' : 'jarvis', body: `rama ${String(index)}`
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
 * A `last_error` is written by an agent: it is foreign text that ends up in the owner's chat. Controls are
 * stripped and it is bounded, just like any untrusted output.
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
