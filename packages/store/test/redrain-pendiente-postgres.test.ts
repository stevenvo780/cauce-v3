import { preparePostgresSuite } from './postgres-suite.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { PublishMessage, Tenant } from '@cauce/protocol';
import {
  CauceRepository, DEFAULT_ACK_DEADLINE_MS, claimableIdleRecipients, releaseControlHold,
  releaseSessionControlHolds, takeControlHold, withTransaction, type ControlHold, type DatabasePool,
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { consumer as leaseConsumer, type Consumer } from './helpers/consumer.js';

/*
 * Prod 2026-10-07: a console delivery to zeus stayed `pending` 85 s with no hold and free capacity.
 * Both drains of its own publish ran while the console's receipt read held the fresh row FOR SHARE,
 * `FOR UPDATE SKIP LOCKED` skipped it, and a later hold release woke nobody either.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const TENANT: Tenant = 'Steven';
const HELD = 'argos';
const OTHER = 'socrates';

function command(text: string, recipient = HELD): PublishMessage {
  return {
    version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
    tenant_id: TENANT, room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: TENANT, alias: recipient }], body: { text },
    idempotency_key: randomUUID(), lane: 'interactive', priority: 7,
  };
}

const consumer = (alias: string): Promise<Consumer> => leaseConsumer(repository, TENANT, alias);

const claim = (target: Consumer): ReturnType<CauceRepository['claimDeliveries']> =>
  repository.claimDeliveries(target.tenant, target.alias, target.instanceId, target.epoch, 10,
    DEFAULT_ACK_DEADLINE_MS);

async function seedSession(alias: string): Promise<string> {
  const id = randomUUID();
  const digest = randomBytes(32);
  await pool.query(
    `INSERT INTO terminal_sessions(
       id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
       ticket_sha256,reason,issued_at,expires_at,consumed_at,
       request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id
     ) VALUES(
       $1,'steven',true,'Steven:kant',$2,$3,'claw','claw','harness_rw',
       $4,'redrain suite',now(),now()+interval '10 minutes',now(),$1,$4,$4,1,$5
     )`,
    [id, TENANT, alias, digest, 'a'.repeat(64)],
  );
  return id;
}

const take = async (alias = HELD): Promise<ControlHold> => takeControlHold(pool, {
  tenantId: TENANT, alias, sessionId: await seedSession(alias), operatorId: 'steven',
  windowMs: 600_000, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 3_600,
});

/** A dedicated LISTEN connection: what the gateway's `subscribeDeliveryWakes` hears. */
async function listenWakes(): Promise<{ wakes: unknown[]; close: () => Promise<void> }> {
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  const wakes: unknown[] = [];
  client.on('notification', (message) => {
    if (message.channel === 'cauce_delivery_wake' && message.payload !== undefined) {
      wakes.push(JSON.parse(message.payload));
    }
  });
  await client.query('LISTEN cauce_delivery_wake');
  return { wakes, close: async () => { await client.end(); } };
}

async function settle(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function age(alias: string, seconds: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET available_at=available_at-make_interval(secs => $3),
                           created_at=created_at-make_interval(secs => $3)
      WHERE recipient_tenant=$1 AND recipient_alias=$2`, [TENANT, alias, seconds]);
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE TABLE terminal_control_holds,terminal_sessions');
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true; UPDATE rooms SET enabled=true; UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('a receipt read never hides a fresh delivery from the claim', () => {
  it('claims the delivery while another transaction holds the receipt lock on it', async () => {
    const target = await consumer(HELD);
    const published = await repository.publish(command('recibo en vuelo'));
    const reader = await pool.connect();
    try {
      await reader.query('BEGIN');
      // The exact lock of `reconstructPublishReceipt` and `reconstructCommittedConsoleIntentReceipt`.
      const locked = await reader.query(
        'SELECT id,recipient_tenant,recipient_alias FROM deliveries WHERE message_id=$1 FOR KEY SHARE',
        [published.message_id]);
      expect(locked.rowCount).toBe(1);
      const claimed = await claim(target);
      expect(claimed.map((delivery) => delivery.body.text)).toEqual(['recibo en vuelo']);
    } finally {
      await reader.query('ROLLBACK');
      reader.release();
    }
  });
});

describe('releasing a control hold wakes its alias', () => {
  it('notifies once per alias at the COMMIT of a session teardown, never before', async () => {
    const listener = await listenWakes();
    try {
      const hold = await take();
      await withTransaction(pool, async (client) => {
        await releaseSessionControlHolds(client, hold.session_id, 'session_closed');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(listener.wakes).toEqual([]);
      });
      await settle(() => listener.wakes.length > 0);
      expect(listener.wakes).toEqual([{ tenant_id: TENANT, alias: HELD }]);
    } finally { await listener.close(); }
  });

  it('notifies on an operator release and stays silent when nothing was released', async () => {
    const listener = await listenWakes();
    try {
      const hold = await take();
      await releaseControlHold(pool, { tenantId: TENANT, alias: HELD, holdId: hold.id }, 'operator left');
      await settle(() => listener.wakes.length > 0);
      await withTransaction(pool, async (client) =>
        releaseSessionControlHolds(client, hold.session_id, 'session_closed'));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(listener.wakes).toEqual([{ tenant_id: TENANT, alias: HELD }]);
    } finally { await listener.close(); }
  });
});

describe('the pending sweep reports only connected aliases nothing else will drain', () => {
  const sweep = (minAgeMs = 1_000): Promise<{ tenant_id: string; alias: string }[]> =>
    claimableIdleRecipients(pool, [{ tenant_id: TENANT, alias: HELD }, { tenant_id: TENANT, alias: OTHER }],
      { minAgeMs, humanReservedCapacity: 0 });

  it('reports an aged pending delivery and leaves a fresh one to its own wake', async () => {
    await repository.publish(command('fresca'));
    expect(await sweep()).toEqual([]);
    await age(HELD, 5);
    expect(await sweep()).toEqual([{ tenant_id: TENANT, alias: HELD }]);
  });

  it('skips the alias under a live hold and reports it again once released', async () => {
    await repository.publish(command('retenida'));
    await age(HELD, 5);
    const hold = await take();
    expect(await sweep()).toEqual([]);
    await releaseControlHold(pool, { tenantId: TENANT, alias: HELD, holdId: hold.id }, 'operator left');
    expect(await sweep()).toEqual([{ tenant_id: TENANT, alias: HELD }]);
  });

  it('reports an alias whose hold expired without anyone releasing it', async () => {
    await repository.publish(command('control caducado'));
    await age(HELD, 5);
    const hold = await take();
    await pool.query(
      `UPDATE terminal_control_holds SET taken_at=now()-interval '10 minutes',expires_at=now()-interval '1 second'
        WHERE id=$1`, [hold.id]);
    expect(await sweep()).toEqual([{ tenant_id: TENANT, alias: HELD }]);
  });

  it('skips an alias whose durable capacity is full', async () => {
    const target = await consumer(HELD);
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries) VALUES($1,$2,false,1)
       ON CONFLICT(tenant_id,alias) DO UPDATE SET max_concurrent_deliveries=EXCLUDED.max_concurrent_deliveries`,
      [TENANT, HELD]);
    await repository.publish(command('en vuelo'));
    expect(await claim(target)).toHaveLength(1);
    await repository.publish(command('esperando hueco'));
    await age(HELD, 5);
    expect(await sweep()).toEqual([]);
    expect(await claimableIdleRecipients(pool, [{ tenant_id: TENANT, alias: HELD }],
      { minAgeMs: 1_000, humanReservedCapacity: 1 })).toEqual([{ tenant_id: TENANT, alias: HELD }]);
  });
});
