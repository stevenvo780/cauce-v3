import { preparePostgresSuite } from './postgres-suite.js';
/**
 * Coalescing of failure notices across delegations:
 *
 * Groups redundant failure notifications to the parent node preserving the aggregate count
 * and the causal detail of each failure.
 */
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { failureSignature } from '../src/repository.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  ackWith as applyTerminalAck, consumer as leaseConsumer, nextDelivery as claimNext,
  type Consumer
} from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
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

const consumer = (tenant: Tenant, alias: string): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias);

async function claimAll(target: Consumer, limit = 20): Promise<DeliveryEnvelope[]> {
  return repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, limit, 30_000
  );
}

const nextDelivery = (target: Consumer): Promise<DeliveryEnvelope> =>
  claimNext(repository, target);

/** Terminal `done` ACK, with delegations. */
const ackDone = async (
  target: Consumer, delivery: DeliveryEnvelope, messages: unknown[], reply: string | null = 'listo'
): Promise<void> => {
  await applyTerminalAck(repository, target, delivery, { messages, reply });
};

/** Terminal non-retryable `failed` ACK: exactly what the notice to the parent produces. */
async function ackFailed(
  target: Consumer, delivery: DeliveryEnvelope,
  error = 'harness exited before producing a reply', errorCode = 'PROCESS_EXIT'
): Promise<Ack> {
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
  return ack;
}

async function setCoalescing(enabled: boolean, windowSeconds = 900): Promise<void> {
  await pool.query(
    `UPDATE agent_chain_policies
     SET failure_coalesce_enabled=$1,failure_coalesce_window_seconds=$2 WHERE id='default'`,
    [enabled, windowSeconds]
  );
}

/** The notice deliveries the parent would actually receive: one row = one message in its queue. */
async function noticesTo(alias: string): Promise<{ text: string; delivery_id: string }[]> {
  return (await pool.query<{ text: string; delivery_id: string }>(
    `SELECT message.body->>'text' AS text,delivery.id AS delivery_id
     FROM deliveries delivery
     JOIN messages message ON message.id=delivery.message_id
     WHERE delivery.recipient_alias=$1 AND message.body->>'type'='agent.response'
     ORDER BY message.created_at,delivery.id`,
    [alias]
  )).rows;
}

async function buckets(): Promise<{
  id: string; child_alias: string; failure_signature: string;
  notices_emitted: number; total_failures: number;
}[]> {
  return (await pool.query<{
    id: string; child_alias: string; failure_signature: string;
    notices_emitted: number; total_failures: number;
  }>(
    `SELECT id::text AS id,child_alias,failure_signature,notices_emitted,total_failures
     FROM agent_failure_notices ORDER BY id`
  )).rows;
}

/**
 * Miniature incident scenario: argos sends a request to kant, kant opens `branches` branches
 * toward socrates, and all die. They all share (parent=kant, child=socrates, root), which is
 * exactly the coalescence key.
 */
async function fanoutThatDies(
  branches: number,
  failures: { error: string; code: string }[]
): Promise<{ kant: Consumer; socrates: Consumer; rootMessageId: string }> {
  const { kant, socrates, rootMessageId, children } = await fanout(branches);
  for (const [index, child] of children.entries()) {
    const failure = failures[index] ?? requireValue(failures[failures.length - 1], 'failures');
    await ackFailed(socrates, child, failure.error, failure.code);
  }
  return { kant, socrates, rootMessageId };
}

async function fanout(branches: number): Promise<{
  kant: Consumer; socrates: Consumer; rootMessageId: string; children: DeliveryEnvelope[];
}> {
  const kant = await consumer('Steven', 'kant');
  const socrates = await consumer('Steven', 'socrates');
  const published = await repository.publish(command());
  const root = await nextDelivery(kant);
  await ackDone(
    kant, root,
    Array.from({ length: branches }, (_, index) => ({ to: 'socrates', body: `rama ${String(index)}` }))
  );
  const children = await claimAll(socrates, branches);
  expect(children).toHaveLength(branches);
  return { kant, socrates, rootMessageId: published.message_id, children };
}

async function standingFailure(branches = 2): Promise<Awaited<ReturnType<typeof fanout>> & {
  notice: { text: string; delivery_id: string };
}> {
  await setCoalescing(true);
  const fixture = await fanout(branches);
  await ackFailed(fixture.socrates, requireValue(fixture.children[0], 'first child'));
  return { ...fixture, notice: requireValue((await noticesTo('kant'))[0], 'first notice') };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000, ['failureSignature']);

beforeEach(async () => {
  if (!databaseStarted) return;
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

describe('coalescencia de avisos de fracaso', () => {
  const sameCause = [{ error: 'harness exited before producing a reply', code: 'PROCESS_EXIT' }];

  it('una ráfaga concurrente después de un aviso terminado emite uno nuevo y conserva el ledger', async () => {
    const { socrates, children, notice } = await standingFailure(6);
    await pool.query("UPDATE deliveries SET status='done',terminal_at=now() WHERE id=$1", [notice.delivery_id]);

    const acks = await Promise.all(children.slice(1).map((child) => ackFailed(socrates, child)));

    expect(await noticesTo('kant')).toHaveLength(2);
    expect((await buckets())[0]).toMatchObject({ total_failures: 6, notices_emitted: 2 });
    const before = await pool.query<{ coalesced: boolean; notice_message_id: string }>(
      'SELECT coalesced,notice_message_id FROM agent_failure_notice_events ORDER BY ack_delivery_id'
    );
    expect(before.rows).toHaveLength(6);
    expect(before.rows.filter((event) => !event.coalesced)).toHaveLength(2);
    expect(new Set(before.rows.map((event) => event.notice_message_id)).size).toBe(2);
    const outbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM adapter_outbox WHERE idempotency_key LIKE 'agent-response:%'"
    );
    expect(outbox.rows[0]?.count).toBe('2');

    const duplicate = await repository.ackDelivery(
      requireValue(children[1], 'second child').delivery_id, socrates.tenant, socrates.alias,
      requireValue(acks[0], 'first ack')
    );
    expect(duplicate).toMatchObject({ applied: false, receipt: 'duplicate' });
    expect(await noticesTo('kant')).toHaveLength(2);
    expect((await buckets())[0]).toMatchObject({ total_failures: 6, notices_emitted: 2 });
    const after = await pool.query(
      'SELECT coalesced,notice_message_id FROM agent_failure_notice_events ORDER BY ack_delivery_id'
    );
    expect(after.rows).toEqual(before.rows);
    expect((await pool.query("SELECT count(*)::text AS count FROM audit_events WHERE action='agent_output.response' AND decision='allow'")).rows)
      .toEqual([{ count: '6' }]);
    expect((await pool.query("SELECT count(*)::text AS count FROM adapter_outbox WHERE idempotency_key LIKE 'agent-response:%'")).rows)
      .toEqual(outbox.rows);
  });

  it('pliega cinco fracasos idénticos en UNA sola entrega hacia el padre', async () => {
    await setCoalescing(true);

    await fanoutThatDies(5, sameCause);

    // The only thing that changes relative to production is the number: five dead branches, five notices.
    const notices = await noticesTo('kant');
    expect(notices).toHaveLength(1);

    const bucket = (await buckets())[0];
    expect(bucket?.child_alias).toBe('socrates');
    expect(bucket?.total_failures).toBe(5);
    expect(bucket?.notices_emitted).toBe(1);
  });

  it('el detalle es default-deny para quien no es ni el padre ni el hijo', async () => {
    await setCoalescing(true);
    await fanoutThatDies(3, sameCause);
    const bucketId = requireValue((await buckets())[0], 'value').id;

    // `salva` lives in another non-hub tenant: it cannot enumerate other chains.
    await expect(repository.failureNoticeDetail(bucketId, 'Isa', 'salva')).rejects.toThrow();
    // The child can: it's its own failure.
    const detail = await repository.failureNoticeDetail(bucketId, 'Steven', 'socrates');
    const childFailures = detail.failures as Record<string, unknown>[];
    const childNotice = detail.notice as Record<string, unknown>;
    expect(typeof childNotice.total_failures).toBe('number');
    expect(childNotice.child_alias).toBe('socrates');
    expect(childFailures.length).toBeGreaterThan(0);
  });

  it('NO pliega dos causas distintas: un problema nuevo nunca queda detrás de uno viejo', async () => {
    await setCoalescing(true);

    // Same branch, same child, same root: only the why changes.
    await fanoutThatDies(4, [
      { error: 'harness exited before producing a reply', code: 'PROCESS_EXIT' },
      { error: 'harness exited before producing a reply', code: 'PROCESS_EXIT' },
      { error: 'no credential available for the provider', code: 'AUTH_EXPIRED' },
      { error: 'no credential available for the provider', code: 'AUTH_EXPIRED' }
    ]);

    // Two causes -> two buckets -> two notices. Four failures, not four deliveries, but also
    // not a single one that would have hidden AUTH_EXPIRED behind PROCESS_EXIT.
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
    // Five branches of the SAME chain toward the SAME child: one bucket for all five.
    await ackDone(
      kant, root, Array.from({ length: 5 }, (_, index) => ({ to: 'socrates', body: `rama ${String(index)}` }))
    );
    const children = await claimAll(socrates, 5);
    expect(children).toHaveLength(5);

    // First burst: 1 notice + 2 folded.
    for (const child of children.slice(0, 3)) {
      await ackFailed(socrates, child, requireValue(sameCause[0], 'sameCause').error, requireValue(sameCause[0], 'sameCause').code);
    }
    expect(await noticesTo('kant')).toHaveLength(1);

    // Aging the window is the only honest way to test the edge without sleeping 15 minutes:
    // the bucket's clock moves, not the test's.
    await pool.query(`UPDATE agent_failure_notices SET window_expires_at=now()-interval '1 second'`);

    // Second burst, already outside the window: the parent learns again. That the storm keeps
    // burning must reach it; what it can't is to reach it once per death.
    for (const child of children.slice(3)) {
      await ackFailed(socrates, child, requireValue(sameCause[0], 'sameCause').error, requireValue(sameCause[0], 'sameCause').code);
    }

    const bucket = (await buckets())[0];
    expect(bucket?.notices_emitted).toBe(2);
    expect(bucket?.total_failures).toBe(5);
    const notices = await noticesTo('kant');
    expect(notices).toHaveLength(2);
    // Full accounting across the two notices: 5 failures, 2 deliveries, 3 that never traveled
    // alone (the 2nd and 3rd of the first burst, and the 5th of the second). None got lost.
    expect(notices[0]?.text).toContain('3 failures with this same cause from socrates');
    expect(notices[0]?.text).toContain('2 of them were coalesced into this notice');
    expect(notices[1]?.text).toContain('5 failures with this same cause from socrates');
    expect(notices[1]?.text).toContain('3 of them were coalesced into this notice');
  });

  it('un aviso plegado deja la contabilidad de fan-in intacta', async () => {
    await setCoalescing(true);

    await fanoutThatDies(3, sameCause);

    // materializeAgentFanin counts audit_events 'agent_output.response' by child_delivery_id.
    // If folding stopped writing them, the chain would wait forever for a response that will
    // never come: the notice storm would have been swapped for a silent hang.
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

  it('separa dos causas distintas y prefiere el código de error al texto', () => {
    expect(failureSignature('failed', 'boom', 'AUTH_EXPIRED'))
      .not.toBe(failureSignature('failed', 'boom', 'PROCESS_EXIT'));
    expect(failureSignature('failed', 'un texto', 'AUTH_EXPIRED'))
      .toBe(failureSignature('failed', 'otro texto totalmente distinto', 'AUTH_EXPIRED'));
  });
});
