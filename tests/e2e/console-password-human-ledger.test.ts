import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { consumeConsoleRoots, object, startConsoleLedgerFixture } from './console-password-human-ledger.fixtures.js';

let fixture: Awaited<ReturnType<typeof startConsoleLedgerFixture>> | undefined;
function current() { if (fixture === undefined) throw new Error('Fixture is unavailable'); return fixture; }
beforeAll(async () => { fixture = await startConsoleLedgerFixture(); }, 120_000);
afterAll(async () => { await fixture?.close(); });

test('password-authenticated A/B/A roots retain distinct canonical human initiators', async () => {
  const a = await current().login(0); const b = await current().login(1); const again = await current().login(0);
  expect(again.cookie).not.toBe(a.cookie);
  const roots = [await current().publish(a), await current().publish(b), await current().publish(again)];
  const rows = (await current().pool.query<{ human_id: string; message_id: string; root_message_id: string; conversation_id: string }>(
    'SELECT initiating_human_id AS human_id,message_id,root_message_id,conversation_id FROM human_message_initiators WHERE message_id=ANY($1)',
    [roots.map((root) => root.receipt.message_id)],
  )).rows;
  expect(rows).toHaveLength(3);
  const human = roots.map((root) => rows.find((row) => row.message_id === root.receipt.message_id));
  expect(human.map((row) => row?.human_id)).toEqual([current().users[0]?.id, current().users[1]?.id, current().users[0]?.id]);
  expect(new Set(rows.map((row) => row.conversation_id)).size).toBe(1);
  for (const row of rows) expect(row.root_message_id).toBe(row.message_id);
  const shared = process.env.CAUCE_SHARED_SESSION;
  process.env.CAUCE_SHARED_SESSION = '1';
  try {
    const consumed = await consumeConsoleRoots(current(), roots.map((root) => root.receipt.message_id));
    expect(consumed.deliveries.map((delivery) => delivery.human_initiator?.human_id)).toEqual(
      [current().users[0]?.id, current().users[1]?.id, current().users[0]?.id]);
    expect(consumed.requests).toHaveLength(3);
    const sessions = consumed.requests.map((request) => request.sessionId);
    expect(sessions[0]).toBeTruthy(); expect(sessions[0]).not.toBe(sessions[1]); expect(sessions[2]).toBe(sessions[0]);
    expect(consumed.requests[2]?.args).toContain('--resume');
    for (const [index, request] of consumed.requests.entries()) {
      const expectedHuman = current().users[index === 1 ? 1 : 0]?.id;
      expect(request.stdin).toContain(`"human_id":"${String(expectedHuman)}"`);
    }
    const acknowledgements = await current().pool.query<{ delivery_id: string; reply: string }>("SELECT delivery_id,payload->'result'->'output'->>'reply' AS reply FROM delivery_acks WHERE delivery_id=ANY($1) AND status=$2 AND applied",
      [consumed.deliveries.map((delivery) => delivery.delivery_id), 'done']);
    expect(acknowledgements.rows).toHaveLength(3);
    for (const [index, delivery] of consumed.deliveries.entries()) {
      const ack = acknowledgements.rows.find((row) => row.delivery_id === delivery.delivery_id);
      expect(ack?.reply).toBe(`owned output ${String(current().users[index === 1 ? 1 : 0]?.id)}`);
    }
  } finally {
    if (shared === undefined) delete process.env.CAUCE_SHARED_SESSION; else process.env.CAUCE_SHARED_SESSION = shared;
  }
});


test('missing membership and forged body identity cannot grant publication authority', async () => {
  const missing = await current().login(2);
  const before = await current().pool.query<{ count: string }>('SELECT count(*) FROM messages');
  const denied = await current().send('/v3/console/publish-intents', { ...current().command(), intent_nonce: randomUUID() }, missing);
  expect(denied.status).toBe(403);
  const a = await current().login(0);
  const command = { ...current().command(), body: { text: 'own forged metadata fixture',
    human_id: current().users[1]?.id, human_initiator: { human_id: current().users[1]?.id },
    console_human_subject: `human:${'f'.repeat(64)}` } };
  const prepared = await current().prepare(a, command);
  const response = await current().send('/v3/console/messages', prepared.body, a);
  expect(response.status).toBe(202);
  const messageId = object(response.body).message_id;
  const owner = await current().pool.query<{ initiating_human_id: string }>(
    'SELECT initiating_human_id FROM human_message_initiators WHERE message_id=$1', [messageId]);
  expect(owner.rows[0]?.initiating_human_id).toBe(current().users[0]?.id);
  const after = await current().pool.query<{ count: string }>('SELECT count(*) FROM messages');
  expect(Number(after.rows[0]?.count)).toBe(Number(before.rows[0]?.count) + 1);
  const confirm = { message_id: messageId, idempotency_key: object(response.body).idempotency_key,
    causal_hash: object(response.body).causal_hash };
  const b = await current().login(1);
  const foreign = await current().send('/v3/console/publish-intents/confirm', confirm, b);
  expect(foreign.status).not.toBe(200);
  expect((await current().send('/v3/console/publish-intents/confirm', confirm, a)).status).toBe(200);
  const retry = await current().send('/v3/console/messages', prepared.body, a);
  expect(retry.status).toBe(202); expect(object(retry.body).message_id).toBe(messageId);
});

async function blockedBy(pid: number): Promise<number> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = (await current().pool.query<{ pid: number }>(
      'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid],
    )).rows;
    if (rows[0]) return rows[0].pid;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('Expected physical PostgreSQL lock waiter');
}

test('revocation committed while authority is blocked denies without journal effects', async () => {
  const a = await current().login(0);
  const before = await current().pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'");
  const client = await current().pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp(),revision=revision+1
      WHERE human_id=$1`, [current().users[0]?.id]);
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (pid === undefined) throw new Error('Missing blocker PID');
    const pending = current().send('/v3/console/publish-intents', { ...current().command(), intent_nonce: randomUUID() }, a);
    await blockedBy(pid);
    await client.query('COMMIT');
    expect((await pending).status).toBe(403);
    expect((await current().pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'")).rows).toEqual(before.rows);
  } finally {
    await client.query('ROLLBACK'); client.release();
    await current().pool.query(`UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL,revision=revision+1 WHERE human_id=$1`, [current().users[0]?.id]);
  }
});

test('client cancellation removes the physically blocked authority backend', async () => {
  const a = await current().login(0);
  const client = await current().pool.connect();
  const abort = new AbortController();
  try {
    await client.query('BEGIN');
    await client.query('SELECT * FROM human_tenant_memberships WHERE human_id=$1 FOR UPDATE', [current().users[0]?.id]);
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (pid === undefined) throw new Error('Missing blocker PID');
    const pending = current().send('/v3/console/publish-intents', { ...current().command(), intent_nonce: randomUUID() }, a, abort.signal)
      .then(() => { throw new Error('Cancelled request completed'); }, (error: unknown) => error);
    const waiter = await blockedBy(pid);
    abort.abort(); await pending;
    await expect.poll(async () => (await current().pool.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [waiter])).rowCount,
      { timeout: 3000 }).toBe(0);
  } finally { abort.abort(); await client.query('ROLLBACK'); client.release(); }
});


test.each(['account', 'role', 'password', 'member-role', 'member-permission'] as const)(
  'fresh locked authority rejects %s revocation after the password snapshot', async (change) => {
    const context = current();
    const a = await context.login(0);
    const userId = context.users[0]?.id;
    const before = await context.pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'");
    const blocker = await context.pool.connect();
    try {
      await blocker.query('BEGIN');
      if (change === 'account') await blocker.query('UPDATE console_users SET active=false WHERE id=$1', [userId]);
      if (change === 'role') await blocker.query("UPDATE console_users SET role='reader' WHERE id=$1", [userId]);
      if (change === 'password') await blocker.query("UPDATE console_users SET password_changed_at=clock_timestamp()+interval '5 seconds' WHERE id=$1", [userId]);
      if (change === 'member-role') await blocker.query("UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read'],revision=revision+1 WHERE human_id=$1", [userId]);
      if (change === 'member-permission') await blocker.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'],revision=revision+1 WHERE human_id=$1", [userId]);
      const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing blocker PID');
      const pending = context.send('/v3/console/publish-intents', { ...context.command(), intent_nonce: randomUUID() }, a);
      await blockedBy(pid);
      await blocker.query('COMMIT');
      expect((await pending).status).toBe(403);
      expect((await context.pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'")).rows).toEqual(before.rows);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await context.pool.query("UPDATE console_users SET active=true,role='operator',password_changed_at=clock_timestamp()-interval '5 seconds' WHERE id=$1", [userId]);
      await context.pool.query("UPDATE human_tenant_memberships SET role='operator',permissions=ARRAY['route','read'],revision=revision+1 WHERE human_id=$1", [userId]);
    }
  },
);

test('reusing a legacy operator scope cannot transfer an existing root to another UUID', async () => {
  const context = current();
  const a = context.users[0]; const b = context.users[1];
  if (a === undefined || b === undefined) throw new Error('Missing accounts');
  const session = await context.login(0);
  const root = await context.publish(session);
  const before = (await context.pool.query('SELECT count(*) FROM messages')).rows;
  try {
    await context.pool.query('UPDATE console_users SET email=$2,email_normalized=$2 WHERE id=$1', [a.id, `retired-${randomUUID()}@fixture.invalid`]);
    await context.pool.query('UPDATE console_users SET email=$2,email_normalized=$2 WHERE id=$1', [b.id, a.email]);
    const loggedIn = await context.send('/v3/auth/login', { email: a.email, password: b.password });
    const csrf = object(loggedIn.body).csrf_token;
    if (!loggedIn.cookie || typeof csrf !== 'string') throw new Error('Scope reuse login failed');
    const foreign = { cookie: loggedIn.cookie, csrf };
    const { idempotency_key, ...semantics } = root.body;
    void idempotency_key;
    const prepared = await context.send('/v3/console/publish-intents', { ...semantics, intent_nonce: root.nonce }, foreign);
    expect(prepared.status).toBe(404);
    const confirmed = await context.send('/v3/console/publish-intents/confirm', {
      message_id: root.receipt.message_id, idempotency_key: root.receipt.idempotency_key, causal_hash: root.receipt.causal_hash,
    }, foreign);
    expect(confirmed.status).toBe(404);
    expect((await context.pool.query('SELECT count(*) FROM messages')).rows).toEqual(before);
    expect((await context.pool.query<{ initiating_human_id: string }>('SELECT initiating_human_id FROM human_message_initiators WHERE message_id=$1',
      [root.receipt.message_id])).rows[0]?.initiating_human_id).toBe(a.id);
  } finally {
    await context.pool.query('UPDATE console_users SET email=$2,email_normalized=$2 WHERE id=$1', [b.id, b.email]);
    await context.pool.query('UPDATE console_users SET email=$2,email_normalized=$2 WHERE id=$1', [a.id, a.email]);
  }
});

test('account and human membership revocations wait behind an admitted transaction', async () => {
  const context = current();
  const a = await context.login(0);
  const roomLock = await context.pool.connect();
  const revoke = await context.pool.connect();
  const accountRevoke = await context.pool.connect();
  try {
    await roomLock.query('BEGIN');
    await roomLock.query('SELECT * FROM rooms WHERE id=$1 FOR UPDATE', [context.room]);
    const roomPid = (await roomLock.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (roomPid === undefined) throw new Error('Missing room blocker PID');
    const pending = context.send('/v3/console/publish-intents', { ...context.command(), intent_nonce: randomUUID() }, a);
    const admitted = await blockedBy(roomPid);
    await revoke.query('BEGIN');
    const revokePid = (await revoke.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await accountRevoke.query('BEGIN');
    const accountPid = (await accountRevoke.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (revokePid === undefined || accountPid === undefined) throw new Error('Missing revocation PIDs');
    const revocation = revoke.query(`UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp(),revision=revision+1
      WHERE human_id=$1`, [context.users[0]?.id]);
    const accountRevocation = accountRevoke.query('UPDATE console_users SET active=false WHERE id=$1', [context.users[0]?.id]);
    await expect.poll(async () => (await context.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) ORDER BY pid', [admitted])).rows.map((row) => row.pid),
      { timeout: 3000 }).toEqual([revokePid, accountPid].sort((left, right) => left - right));

    await roomLock.query('COMMIT');
    expect((await pending).status).toBe(200);
    await revocation; await revoke.query('COMMIT');
    await accountRevocation; await accountRevoke.query('COMMIT');
    const row = (await context.pool.query<{ enabled: boolean }>('SELECT enabled FROM human_tenant_memberships WHERE human_id=$1', [context.users[0]?.id])).rows[0];
    expect(row?.enabled).toBe(false);
  } finally {
    await roomLock.query('ROLLBACK'); roomLock.release();
    await revoke.query('ROLLBACK'); revoke.release();
    await accountRevoke.query('ROLLBACK'); accountRevoke.release();
    await context.pool.query('UPDATE console_users SET active=true WHERE id=$1', [context.users[0]?.id]);
    await context.pool.query('UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL,revision=revision+1 WHERE human_id=$1', [context.users[0]?.id]);
  }
});


test('direct publication and adapters without the capability preserve legacy omission', async () => {
  const context = current();
  const b = await context.login(1);
  const command = { ...context.command(), idempotency_key: `legacy-${randomUUID()}` };
  const direct = await context.send('/v3/messages', command, b);
  expect(direct.status).toBe(202);
  const directId = object(direct.body).message_id;
  expect((await context.pool.query('SELECT * FROM human_message_initiators WHERE message_id=$1', [directId])).rows).toHaveLength(0);
  const retry = await context.send('/v3/messages', command, b);
  expect(retry.status).toBe(202); expect(object(retry.body).message_id).toBe(directId);
  expect((await context.send('/v3/messages', { ...command, body: { text: 'changed' } }, b)).status).toBe(409);
  const human = await context.publish(b);
  const instance = context.instance;
  const lease = await context.repository.acquireLease(context.tenant, context.target, instance, [], 60_000, { resume: true });
  if (lease.epoch === undefined) throw new Error('Missing legacy lease');
  const deliveries = await context.repository.claimDeliveries(context.tenant, context.target, instance, lease.epoch, 100, 30_000);
  const claim = deliveries.find((delivery) => delivery.message_id === human.receipt.message_id);
  expect(claim).toBeDefined(); expect(claim?.human_initiator).toBeUndefined();
  expect((await context.pool.query('SELECT * FROM human_message_initiators WHERE message_id=$1', [human.receipt.message_id])).rows).toHaveLength(1);
});


test('console-only capability retains A/B/A isolation without projecting its durable initiator', async () => {
  const context = current();
  const sessions = [await context.login(0), await context.login(1), await context.login(0)];
  const ids: string[] = [];
  for (const session of sessions) ids.push((await context.publish(session)).receipt.message_id);
  expect((await context.pool.query('SELECT * FROM human_message_initiators WHERE message_id=ANY($1)', [ids])).rows)
    .toHaveLength(3);
  const previous = process.env.CAUCE_SHARED_SESSION;
  process.env.CAUCE_SHARED_SESSION = '1';
  try {
    const consumed = await consumeConsoleRoots(context, ids,
      { capabilities: ['console_human_scope_v1'], requireHumanPrompt: false });
    expect(consumed.deliveries.every((delivery) => delivery.human_initiator === undefined)).toBe(true);
    const subjects = consumed.deliveries.map((delivery) => delivery.console_human_subject);
    for (const subject of subjects) expect(subject).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(subjects[0]).not.toBe(subjects[1]); expect(subjects[2]).toBe(subjects[0]);
    expect(consumed.requests).toHaveLength(3);
    const nativeIds = consumed.requests.map((request) => request.sessionId);
    expect(nativeIds[0]).toBeTruthy(); expect(nativeIds[1]).toBeTruthy();
    expect(nativeIds[0]).not.toBe(nativeIds[1]); expect(nativeIds[2]).toBe(nativeIds[0]);
    expect(consumed.requests[2]?.args).toContain('--resume');
    const acknowledgements = await context.pool.query('SELECT delivery_id FROM delivery_acks WHERE delivery_id=ANY($1) AND status=$2 AND applied',
      [consumed.deliveries.map((delivery) => delivery.delivery_id), 'done']);
    expect(acknowledgements.rows).toHaveLength(3);
  } finally {
    if (previous === undefined) delete process.env.CAUCE_SHARED_SESSION; else process.env.CAUCE_SHARED_SESSION = previous;
  }
});

test('absolute password session expiry bounds an in-flight locked transaction', async () => {
  const context = await startConsoleLedgerFixture({ sessionTtlMs: 2500 });
  const blocker = await context.pool.connect();
  try {
    const a = await context.login(0);
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM human_tenant_memberships WHERE human_id=$1 FOR UPDATE', [context.users[0]?.id]);
    const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (blockerPid === undefined) throw new Error('Missing blocker');
    const response = context.send('/v3/console/publish-intents', { ...context.command(), intent_nonce: randomUUID() }, a);
    await expect.poll(async () => (await context.pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid])).rowCount,
      { timeout: 1000 }).toBe(1);
    const expired = await response;
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect((await context.pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'")).rows).toHaveLength(0);
    expect((await context.pool.query('SELECT * FROM human_message_initiators')).rows).toHaveLength(0);
  } finally {
    await blocker.query('ROLLBACK'); blocker.release(); await context.close();
  }
});


test('disconnect during the session lookup cannot create a prepared intent', async () => {
  const isolated = await startConsoleLedgerFixture({ retainSessionLookup: true });
  const a = await isolated.login(0);
  const nonce = randomUUID();
  const blocker = await isolated.pool.connect();
  const controller = new AbortController();
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    expect(condition()).toBe(true);
  };
  try {
    const before = (await isolated.pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'")).rows;
    // The preHandler runs after real cookie/CSRF authentication and complete body parsing.
    let blockerPid: number | undefined;
    const original = isolated.provider.verifiedConsoleSession.bind(isolated.provider);
    isolated.provider.verifiedConsoleSession = async (request) => {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE console_users IN ACCESS EXCLUSIVE MODE');
      blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      return await original(request);
    };
    const response = isolated.send('/v3/console/publish-intents',
      { ...isolated.command(), intent_nonce: nonce }, a, controller.signal).catch((error: unknown) => error);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      if (blockerPid !== undefined) waiting = (await isolated.pool.query(
        'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [blockerPid])).rowCount !== 0;
      if (!waiting) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    expect(waiting).toBe(true);
    controller.abort(); expect(await response).toBeInstanceOf(Error);
    await wait(() => isolated.disconnected.has(nonce));
    await blocker.query('COMMIT');
    await wait(() => isolated.completed.has(nonce));
    expect((await isolated.pool.query("SELECT * FROM audit_events WHERE action LIKE 'console.publish.%'")).rows).toEqual(before);
  } finally {
    controller.abort(); await blocker.query('ROLLBACK'); blocker.release(); await isolated.close();
  }
});
