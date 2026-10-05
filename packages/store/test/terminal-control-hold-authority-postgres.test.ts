import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CauceRepository, CONTROL_HOLD_MAX_WINDOW_MS, DEFAULT_ACK_DEADLINE_MS, StoreError,
  lockTerminalControlLease, releaseSessionControlHolds, takeControlHold,
  takeControlHoldWithinTransaction, withTransaction,
  type ControlHoldTake, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { consumer } from './helpers/consumer.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
const identity = { tenantId: 'Steven', alias: 'argos' };

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  pool = database.pool;
  console.info(`control-hold-authority container ${database.container.getId()}`);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE TABLE terminal_control_holds,terminal_sessions');
});

afterAll(async () => {
  if (database === undefined) return;
  const errors: unknown[] = [];
  try { await database.pool.end(); } catch (error) { errors.push(error); }
  try { await database.container.stop(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, 'control hold test cleanup failed');
});

async function seed(ttlSeconds = 900): Promise<ControlHoldTake> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO terminal_sessions(
       id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
       ticket_sha256,reason,issued_at,expires_at,consumed_at,request_id,request_sha256,
       browser_owner_sha256,browser_owner_generation,relay_instance_id
     ) VALUES($1,'steven',true,'Steven:kant',$2,$3,'claw','claw','harness_rw',
       $4,'authority hold fixture',clock_timestamp(),clock_timestamp()+interval '10 minutes',
       clock_timestamp(),$1,$4,$4,1,$5)`,
    [id, identity.tenantId, identity.alias, randomBytes(32), 'a'.repeat(64)],
  );
  return { ...identity, sessionId: id, operatorId: 'steven', reason: 'operator typing',
    windowMs: 60_000, sessionTtlSeconds: ttlSeconds, sessionMaxTotalSeconds: null };
}

async function deadline(seconds: number): Promise<Date> {
  const result = await pool.query<{ deadline: Date }>(
    'SELECT clock_timestamp()+make_interval(secs => $1) AS deadline', [seconds],
  );
  const value = result.rows[0]?.deadline;
  if (value === undefined) throw new Error('deadline fixture missing');
  return value;
}

async function holds(): Promise<number> {
  return (await pool.query('SELECT id FROM terminal_control_holds')).rows.length;
}

async function waitForLock(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await pool.query<{ wait_event_type: string | null }>(
      'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid],
    );
    if (activity.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('hold operation did not wait on the fixture lock');
}

async function waitForBlockedBy(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await pool.query(
      "SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))", [pid],
    );
    if (activity.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('competing wrapper did not wait on the caller lease');
}

async function takeWhileBlocked(
  lock: 'session' | 'lease' | 'hold' | 'live-hold', sessionExpires = false, releaseRollsBack = false,
): Promise<void> {
  const input = await seed(sessionExpires ? 1 : 900);
  const end = sessionExpires
    ? (await pool.query<{ deadline: Date }>(
      'SELECT consumed_at+interval \'1 second\' AS deadline FROM terminal_sessions WHERE id=$1',
      [input.sessionId],
    )).rows[0]?.deadline
    : await deadline(releaseRollsBack ? 30 : 1);
  if (end === undefined) throw new Error('missing expiration fixture');
  const priorHold = lock === 'hold' || lock === 'live-hold' ? randomUUID() : undefined;
  if (priorHold !== undefined) await pool.query(
    `INSERT INTO terminal_control_holds(id,session_id,tenant_id,alias,operator_id,reason,taken_at,expires_at)
     VALUES($1,$2,$3,$4,'steven','expired fixture',clock_timestamp()-interval '2 seconds',clock_timestamp()+($5||' seconds')::interval)`,
    [priorHold, input.sessionId, input.tenantId, input.alias, lock === 'live-hold' ? 60 : -1],
  );
  const blocker = await pool.connect(); const waiter = await pool.connect();
  let result: Promise<{ error: unknown }> | undefined;
  const errors: unknown[] = [];
  try {
    await blocker.query('BEGIN');
    if (lock === 'session') await blocker.query('SELECT id FROM terminal_sessions WHERE id=$1 FOR UPDATE', [input.sessionId]);
    else if (lock === 'lease') await lockTerminalControlLease(blocker, input);
    else if (lock === 'hold') await blocker.query('SELECT id FROM terminal_control_holds WHERE id=$1 FOR UPDATE', [priorHold]);
    else await blocker.query(
      "UPDATE terminal_control_holds SET released_at=clock_timestamp(),released_reason='operator left' WHERE id=$1", [priorHold],
    );
    await waiter.query('BEGIN');
    const pid = (await waiter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (pid === undefined) throw new Error('waiter PID missing');
    result = takeControlHoldWithinTransaction(waiter, input, sessionExpires ? undefined : end)
      .then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await waitForLock(pid);
    if (!releaseRollsBack) {
      await pool.query(
        `SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))+0.05))`, [end],
      );
      expect((await pool.query<{ expired: boolean }>('SELECT clock_timestamp()>$1::timestamptz AS expired', [end])).rows[0]?.expired).toBe(true);
    }
    await blocker.query(releaseRollsBack ? 'ROLLBACK' : 'COMMIT');
    const outcome = await result;
    expect(outcome.error).toMatchObject({ code: releaseRollsBack ? 'conflict' : sessionExpires ? 'not_found' : 'forbidden' });
    await waiter.query('ROLLBACK');
    const remaining = (await pool.query<{ id: string; released: boolean }>('SELECT id,released_at IS NOT NULL AS released FROM terminal_control_holds')).rows;
    expect(remaining).toEqual(priorHold === undefined ? [] : [{ id: priorHold, released: lock === 'live-hold' && !releaseRollsBack }]);
  } catch (error) { errors.push(error); } finally {
    try { await blocker.query('ROLLBACK'); } catch (error) { errors.push(error); }
    if (result !== undefined) await result;
    try { await waiter.query('ROLLBACK'); } catch (error) { errors.push(error); }
    blocker.release(); waiter.release();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'blocked hold fixture failed');
}

describe('terminal hold authority deadline in the caller transaction', () => {
  it('clamps to the immutable authority deadline and rejects invalid or already expired caps', async () => {
    const input = await seed(); const cap = await deadline(30);
    for (const invalid of [new Date(NaN), 'not-a-date' as unknown as Date]) {
      await expect(withTransaction(pool, (client) => takeControlHoldWithinTransaction(client, input, invalid)))
        .rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(withTransaction(pool, (client) => takeControlHoldWithinTransaction(client, input, new Date(0))))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(await holds()).toBe(0);
    const hold = await withTransaction(pool, (client) => takeControlHoldWithinTransaction(client, input, cap));
    expect(hold.expires_at.toISOString()).toBe(cap.toISOString());
    expect(hold.taken_at.getTime()).toBeLessThan(cap.getTime());
    expect(await holds()).toBe(1);
  });

  it('rejects authority that expires while waiting on the terminal row', async () => {
    await takeWhileBlocked('session');
  });

  it('rejects authority that expires while waiting on the connection lease', async () => {
    await takeWhileBlocked('lease');
  });

  it('rejects authority expiring during the final wait to release an expired hold', async () => {
    await takeWhileBlocked('hold');
  });

  it('rejects authority expiring during a concurrent release of a still-live hold', async () => {
    await takeWhileBlocked('live-hold');
  });

  it('keeps the live hold conflict when a concurrent release rolls back', async () => {
    await takeWhileBlocked('live-hold', false, true);
  });

  it('rejects a session window that expires while waiting on its row', async () => {
    await takeWhileBlocked('session', true);
  });

  it('uses fresh DB time after a long transaction and can release in that same transaction', async () => {
    const input = await seed(100_000);
    await withTransaction(pool, async (client) => {
      const started = (await client.query<{ started: Date }>('SELECT now() AS started')).rows[0]?.started;
      if (started === undefined) throw new Error('transaction clock missing');
      await client.query('SELECT pg_sleep(0.05)');
      const hold = await takeControlHoldWithinTransaction(client, { ...input, windowMs: CONTROL_HOLD_MAX_WINDOW_MS });
      expect(hold.taken_at.getTime()).toBeGreaterThan(started.getTime());
      expect(hold.expires_at.getTime() - hold.taken_at.getTime()).toBe(CONTROL_HOLD_MAX_WINDOW_MS);
      const released = await releaseSessionControlHolds(client, input.sessionId, 'operator left');
      expect(released).toHaveLength(1);
      expect(released[0]?.released_at?.getTime()).toBeGreaterThanOrEqual(hold.taken_at.getTime());
    });
    expect((await pool.query('SELECT id FROM terminal_control_holds WHERE released_at IS NOT NULL')).rows).toHaveLength(1);
  });

  it('rolls back the hold when a later caller authority or fencing check fails', async () => {
    const input = await seed();
    await expect(withTransaction(pool, async (client) => {
      await takeControlHoldWithinTransaction(client, input, await deadline(30));
      expect((await client.query('SELECT id FROM terminal_control_holds')).rows).toHaveLength(1);
      throw new StoreError('forbidden', 'fixture authority revoked');
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await holds()).toBe(0);
  });

  it('preserves wrapper window, session clamp, tenant fences and unique live hold conflicts', async () => {
    const input = await seed(30);
    await expect(takeControlHold(pool, { ...input, tenantId: 'Miguel' })).rejects.toMatchObject({ code: 'not_found' });
    const hold = await takeControlHold(pool, input);
    const end = (await pool.query<{ deadline: Date }>(
      'SELECT consumed_at+interval \'30 seconds\' AS deadline FROM terminal_sessions WHERE id=$1', [input.sessionId],
    )).rows[0]?.deadline;
    expect(hold.expires_at.toISOString()).toBe(end?.toISOString());
    await expect(takeControlHold(pool, input)).rejects.toMatchObject({ code: 'conflict' });
    expect(await holds()).toBe(1);
  });

  it('keeps the existing busy guard and permits the explicitly requested busy take', async () => {
    const repository = new CauceRepository(pool); const target = await consumer(repository, 'Steven', 'argos');
    await repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: randomUUID(),
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'busy guard fixture' }, idempotency_key: randomUUID(), lane: 'interactive', priority: 7 });
    const claimed = await repository.claimDeliveries(target.tenant, target.alias, target.instanceId, target.epoch, 1, DEFAULT_ACK_DEADLINE_MS);
    expect(claimed).toHaveLength(1);
    const input = await seed();
    await expect(takeControlHold(pool, input)).rejects.toMatchObject({ code: 'conflict', message: 'agent_busy' });
    expect(await holds()).toBe(0);
    await takeControlHold(pool, { ...input, allowBusy: true });
    expect(await holds()).toBe(1);
  });

  it('serializes a caller with lease then terminal fences against the wrapper without a lock cycle', async () => {
    const input = await seed(); const caller = await pool.connect();
    let competing: Promise<{ error: unknown }> | undefined;
    const errors: unknown[] = [];
    try {
      await caller.query('BEGIN'); await lockTerminalControlLease(caller, input);
      await caller.query('SELECT id FROM terminal_sessions WHERE id=$1 FOR UPDATE', [input.sessionId]);
      const pid = (await caller.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('caller PID missing');
      competing = takeControlHold(pool, input).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
      await waitForBlockedBy(pid);
      const hold = await takeControlHoldWithinTransaction(caller, input, await deadline(30));
      expect(hold.session_id).toBe(input.sessionId);
      await caller.query('COMMIT');
      expect((await competing).error).toMatchObject({ code: 'conflict' });
      expect(await holds()).toBe(1);
    } catch (error) { errors.push(error); } finally {
      try { await caller.query('ROLLBACK'); } catch (error) { errors.push(error); }
      caller.release();
      if (competing !== undefined) await competing;
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'ordered hold fixture failed');
  });
});
