import { preparePostgresSuite } from './postgres-suite.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage, Tenant } from '@cauce/protocol';
import {
  CauceRepository, CONTROL_HOLD_MAX_WINDOW_MS, currentControlHold, DEFAULT_ACK_DEADLINE_MS,
  extendControlHold, releaseControlHold, releaseSessionControlHolds, takeControlHold,
  withTransaction, type ControlHold, type DatabasePool
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import {
  ackWith as applyTerminalAck, consumer as leaseConsumer, deliveryRow, type Consumer
} from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const TENANT: Tenant = 'Steven';
const NEIGHBOUR: Tenant = 'Miguel';
const HELD = 'argos';
const OTHER = 'socrates';
const WINDOW_MS = 600_000;
const SESSION_TTL_SECONDS = 900;
const SESSION_MAX_TOTAL_SECONDS = 3_600;

interface QueuedRow { id: string; status: string; attempt: number; available_at: Date }

function command(text: string, recipient = HELD): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: TENANT,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: TENANT, alias: recipient }],
    body: { text },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7
  };
}

const consumer = (alias: string, tenant: Tenant = TENANT): Promise<Consumer> =>
  leaseConsumer(repository, tenant, alias);

const claim = (target: Consumer, limit = 10): ReturnType<CauceRepository['claimDeliveries']> =>
  repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, limit, DEFAULT_ACK_DEADLINE_MS
  );

async function queued(alias: string): Promise<QueuedRow[]> {
  const result = await pool.query<QueuedRow>(
    `SELECT d.id,d.status,d.attempt,d.available_at FROM deliveries d JOIN messages m ON m.id=d.message_id
      WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2 ORDER BY d.created_at`,
    [TENANT, alias]
  );
  return result.rows;
}

interface SessionOptions {
  mode?: string;
  tenant?: Tenant;
  consumedSecondsAgo?: number | null;
  settled?: 'revoked_at' | 'closed_at';
}

async function seedSession(alias: string, options: SessionOptions = {}): Promise<string> {
  const { mode = 'harness', tenant = TENANT, consumedSecondsAgo = 0, settled } = options;
  const id = randomUUID();
  const digest = randomBytes(32);
  await pool.query(
    `INSERT INTO terminal_sessions(
       id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
       ticket_sha256,reason,issued_at,expires_at,consumed_at,
       request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id
     ) VALUES(
       $1,'steven',true,'Steven:kant',$2,$3,'claw','claw',$4,
       $5,'tui control hold suite',now(),now()+interval '10 minutes',
       CASE WHEN $7::float8 IS NULL THEN NULL ELSE now()-make_interval(secs => $7) END,
       $1,$5,$5,1,$6
     )`,
    [id, tenant, alias, mode, digest, 'a'.repeat(64), consumedSecondsAgo]
  );
  if (settled !== undefined) {
    await pool.query(`UPDATE terminal_sessions SET ${settled}=now() WHERE id=$1`, [id]);
  }
  return id;
}

/** The window end migration 040 computes for a session, read back from the database clock. */
async function sessionWindowEnd(sessionId: string): Promise<Date> {
  const result = await pool.query<{ ends_at: Date }>(
    `SELECT LEAST(GREATEST(consumed_at + make_interval(secs => $2),
                           COALESCE(window_extended_to, 'epoch'::timestamptz)),
                  consumed_at + make_interval(secs => $3)) AS ends_at
       FROM terminal_sessions WHERE id=$1`,
    [sessionId, SESSION_TTL_SECONDS, SESSION_MAX_TOTAL_SECONDS]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the session row is gone');
  return row.ends_at;
}

interface HoldOptions { expiresInSeconds?: number; takenSecondsAgo?: number }

async function takeControl(alias: string, options: HoldOptions = {}): Promise<string> {
  const { expiresInSeconds = 600, takenSecondsAgo = 0 } = options;
  const sessionId = await seedSession(alias);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO terminal_control_holds(
       session_id,tenant_id,alias,operator_id,reason,taken_at,expires_at
     ) VALUES(
       $1,$2,$3,'steven','operator typing',
       now()-($4||' seconds')::interval,now()+($5||' seconds')::interval
     ) RETURNING id`,
    [sessionId, TENANT, alias, String(takenSecondsAgo), String(expiresInSeconds)]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the hold was not inserted');
  return row.id;
}

async function holdRow(id: string): Promise<ControlHold> {
  const result = await pool.query<ControlHold>(
    'SELECT * FROM terminal_control_holds WHERE id=$1', [id]
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('the hold row is gone');
  return row;
}

interface RawHold { takenAt: string; expiresAt: string; releasedAt?: string; releasedReason?: string }

/** Writes a hold with the raw columns the schema is meant to reject, bypassing the store module. */
async function rawHold(values: RawHold): Promise<void> {
  const sessionId = await seedSession(HELD);
  await pool.query(
    `INSERT INTO terminal_control_holds(
       session_id,tenant_id,alias,operator_id,reason,taken_at,expires_at,released_at,released_reason
     ) VALUES(
       $1,$2,$3,'steven','schema probe',now()+$4::interval,now()+$5::interval,
       CASE WHEN $6::text IS NULL THEN NULL ELSE now()+$6::interval END,$7
     )`,
    [sessionId, TENANT, HELD, values.takenAt, values.expiresAt,
      values.releasedAt ?? null, values.releasedReason ?? null]
  );
}

async function release(id: string): Promise<void> {
  await pool.query(
    `UPDATE terminal_control_holds SET released_at=now(),released_reason='operator left'
      WHERE id=$1`,
    [id]
  );
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

describe('a held TUI queues the deliveries of its alias', () => {
  it('leases the pending delivery while nobody holds the terminal', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('sin control tomado'));

    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['sin control tomado']);
  });

  it('leases nothing and leaves the row pending, untouched, while the hold is live', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('con control tomado'));
    const before = await queued(HELD);
    await takeControl(HELD);

    expect(await claim(target)).toEqual([]);
    const after = await queued(HELD);
    expect(after).toEqual(before);
    expect(after.map((row) => ({ status: row.status, attempt: row.attempt })))
      .toEqual([{ status: 'pending', attempt: 0 }]);
  });

  it('resumes claiming in the original order once the control is released', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('antes del control'));
    const hold = await takeControl(HELD);
    await repository.publish(command('durante el control'));
    expect(await claim(target)).toEqual([]);

    await release(hold);
    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text))
      .toEqual(['antes del control', 'durante el control']);
  });

  it('ignores a hold whose window already elapsed', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('control caducado'));
    await takeControl(HELD, { expiresInSeconds: -60, takenSecondsAgo: 600 });

    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['control caducado']);
  });

  it('gates only the alias whose terminal is held', async () => {
    const target = await consumer(OTHER);
    await repository.publish(command('otro alias', OTHER));
    await takeControl(HELD);

    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['otro alias']);
  });

  it('gates only the tenant that holds the terminal, never a namesake alias', async () => {
    // Aliases are keyed (tenant, alias) everywhere: two tenants may own the same name. Without the
    // tenant correlation, an operator holding their own `argos` silences the other tenant's queue.
    await pool.query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'grp.miguel',$2,'agent')`,
      [NEIGHBOUR, HELD]
    );
    const target = await consumer(HELD, NEIGHBOUR);
    await repository.publish({
      ...command('mismo alias, otro inquilino'),
      tenant_id: NEIGHBOUR,
      room_id: 'grp.miguel',
      actor_alias: 'janus',
      recipients: [{ tenant_id: NEIGHBOUR, alias: HELD }]
    });
    await takeControl(HELD);

    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['mismo alias, otro inquilino']);
  });

  it('lets a turn leased before the take finish and ACK under the hold', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('turno en vuelo'));
    const claimed = await claim(target);
    const delivery = claimed[0];
    if (delivery === undefined) throw new Error('the in-flight delivery was not leased');
    await takeControl(HELD);

    await applyTerminalAck(repository, target, delivery, { reply: 'terminado bajo control' });
    expect(await deliveryRow(pool, delivery.delivery_id, 'status')).toEqual({ status: 'done' });
  });

  it('refuses a second live hold on the same alias', async () => {
    await takeControl(HELD);
    await expect(takeControl(HELD)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('migration 040 terminal control holds', () => {
  it('admits the writable TUI mode and still refuses an unknown one', async () => {
    await expect(seedSession(HELD, { mode: 'harness_rw' })).resolves.toBeTypeOf('string');
    await expect(seedSession(HELD, { mode: 'harness_ro' })).rejects.toMatchObject({ code: '23514' });
  });

  it('adds the extension window without touching the slot accounting column', async () => {
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions'
          AND column_name IN ('window_extended_to','consumed_at') ORDER BY column_name`
    );
    expect(columns.rows).toEqual([
      { column_name: 'consumed_at', is_nullable: 'YES' },
      { column_name: 'window_extended_to', is_nullable: 'YES' }
    ]);
  });
});

describe('the store module that takes and releases the control', () => {
  const change = (holdId: string): { tenantId: string; alias: string; holdId: string } =>
    ({ tenantId: TENANT, alias: HELD, holdId });

  const takeOn = async (sessionId: string, windowMs = WINDOW_MS): Promise<ControlHold> =>
    takeControlHold(pool, {
      tenantId: TENANT,
      alias: HELD,
      sessionId,
      operatorId: 'steven',
      reason: 'operator typing',
      windowMs,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      sessionMaxTotalSeconds: SESSION_MAX_TOTAL_SECONDS
    });

  const take = async (windowMs = WINDOW_MS, tenant: Tenant = TENANT): Promise<ControlHold> =>
    takeControlHold(pool, {
      tenantId: tenant,
      alias: HELD,
      sessionId: await seedSession(HELD, { tenant }),
      operatorId: 'steven',
      reason: 'operator typing',
      windowMs,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      sessionMaxTotalSeconds: SESSION_MAX_TOTAL_SECONDS
    });

  it('re-takes the control of an alias whose browser died, releasing the dead hold as expired', async () => {
    const dead = await takeControl(HELD, { expiresInSeconds: -60, takenSecondsAgo: 600 });

    const hold = await take();

    const previous = await holdRow(dead);
    expect(previous.released_reason).toEqual('expired');
    expect(previous.released_at).not.toBeNull();
    expect((await currentControlHold(pool, TENANT, HELD))?.id).toEqual(hold.id);
  });

  it('reads no hold once the window expired, before anyone releases it', async () => {
    await takeControl(HELD, { expiresInSeconds: -60, takenSecondsAgo: 600 });
    expect(await currentControlHold(pool, TENANT, HELD)).toBeUndefined();
  });

  it('refuses to take the control while another hold of the alias is live', async () => {
    await take();
    await expect(take()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('takes the tenant and the alias from the session row, not from the caller', async () => {
    await expect(takeControlHold(pool, {
      tenantId: TENANT,
      alias: HELD,
      sessionId: await seedSession(HELD, { tenant: NEIGHBOUR }),
      operatorId: 'steven',
      reason: 'terminal ajena',
      windowMs: WINDOW_MS,
      sessionTtlSeconds: SESSION_TTL_SECONDS,
      sessionMaxTotalSeconds: SESSION_MAX_TOTAL_SECONDS
    })).rejects.toMatchObject({ code: 'not_found' });
    expect(await currentControlHold(pool, TENANT, HELD)).toBeUndefined();
  });

  it('clamps the hold to the end of the session window, on the database clock', async () => {
    const sessionId = await seedSession(HELD, { consumedSecondsAgo: SESSION_TTL_SECONDS - 30 });

    const hold = await takeOn(sessionId, 900_000);

    const written = await holdRow(hold.id);
    expect(written.expires_at.toISOString()).toEqual((await sessionWindowEnd(sessionId)).toISOString());
    expect(written.expires_at.getTime() - written.taken_at.getTime()).toBeLessThan(900_000);
  });

  it('keeps its own window when the session outlives it', async () => {
    const sessionId = await seedSession(HELD, { consumedSecondsAgo: 0 });

    const hold = await takeOn(sessionId, 60_000);

    const written = await holdRow(hold.id);
    expect(written.expires_at.getTime()).toBeLessThan((await sessionWindowEnd(sessionId)).getTime());
    expect(written.expires_at.getTime() - written.taken_at.getTime()).toEqual(60_000);
  });

  it('never takes the control of a session that is not live', async () => {
    const dead = [
      await seedSession(HELD, { consumedSecondsAgo: null }),
      await seedSession(HELD, { settled: 'revoked_at' }),
      await seedSession(HELD, { settled: 'closed_at' }),
      await seedSession(HELD, { consumedSecondsAgo: SESSION_TTL_SECONDS + 60 })
    ];
    for (const sessionId of dead) {
      await expect(takeOn(sessionId)).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(await currentControlHold(pool, TENANT, HELD)).toBeUndefined();
  });

  it('releases every live hold of a session inside the caller transaction, once', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('encolada bajo cierre'));
    const hold = await take();

    const released = await withTransaction(pool, async (client) =>
      releaseSessionControlHolds(client, hold.session_id, 'session_closed'));
    const again = await withTransaction(pool, async (client) =>
      releaseSessionControlHolds(client, hold.session_id, 'session_closed'));

    expect(released.map((row) => row.id)).toEqual([hold.id]);
    expect(released[0]?.released_reason).toEqual('session_closed');
    expect(again).toEqual([]);
    expect((await holdRow(hold.id)).released_at?.toISOString())
      .toEqual(released[0]?.released_at?.toISOString());
    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['encolada bajo cierre']);
  });

  it('rejects a window outside the ceiling the base enforces', async () => {
    await expect(take(CONTROL_HOLD_MAX_WINDOW_MS + 1)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(take(0)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('records who released the hold and why, and lets the queue resume', async () => {
    const target = await consumer(HELD);
    await repository.publish(command('encolada bajo control'));
    const hold = await take();
    expect(await claim(target)).toEqual([]);

    const released = await releaseControlHold(pool, change(hold.id), 'operator left');

    expect(released.released_reason).toEqual('operator left');
    expect(released.released_at).not.toBeNull();
    expect(await currentControlHold(pool, TENANT, HELD)).toBeUndefined();
    const claimed = await claim(target);
    expect(claimed.map((delivery) => delivery.body.text)).toEqual(['encolada bajo control']);
  });

  it('refuses to release a hold that is not live any more', async () => {
    const hold = await take();
    await releaseControlHold(pool, change(hold.id), 'operator left');
    await expect(releaseControlHold(pool, change(hold.id), 'otra vez'))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('extends the window forward but never past the ceiling of the CHECK', async () => {
    const hold = await take(60_000);

    const extended = await extendControlHold(pool, change(hold.id), CONTROL_HOLD_MAX_WINDOW_MS);

    expect(extended.expires_at.getTime()).toBeGreaterThan(hold.expires_at.getTime());
    expect(extended.expires_at.getTime() - extended.taken_at.getTime())
      .toBeLessThanOrEqual(CONTROL_HOLD_MAX_WINDOW_MS);
  });
});

describe('the schema of the control holds bounds what a hold may claim', () => {
  it('refuses a window that ends before it starts', async () => {
    await expect(rawHold({ takenAt: '0 seconds', expiresAt: '-5 minutes' }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a window above the ceiling', async () => {
    await expect(rawHold({ takenAt: '0 seconds', expiresAt: '13 hours' }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a release with no reason and one that precedes the take', async () => {
    await expect(rawHold({ takenAt: '0 seconds', expiresAt: '10 minutes', releasedAt: '1 minute' }))
      .rejects.toMatchObject({ code: '23514' });
    await expect(rawHold({
      takenAt: '0 seconds', expiresAt: '10 minutes', releasedAt: '-1 hour', releasedReason: 'tarde'
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('admits a well formed hold and its release', async () => {
    await expect(rawHold({ takenAt: '-1 minute', expiresAt: '10 minutes' })).resolves.toBeUndefined();
    await expect(rawHold({
      takenAt: '-2 minutes', expiresAt: '10 minutes', releasedAt: '0 seconds', releasedReason: 'listo'
    })).resolves.toBeUndefined();
  });
});
