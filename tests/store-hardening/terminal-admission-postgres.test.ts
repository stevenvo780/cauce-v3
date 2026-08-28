import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from '../../services/gateway/node_modules/fastify/types/instance.js';
import type { Principal } from '../../services/gateway/src/auth.js';
import { createConsoleSecurityHook } from '../../services/gateway/src/console-security.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import {
  deriveAliasKey, verifyTicketSignature,
} from '../../services/gateway/src/terminal/tickets.js';
import type { DatabasePool } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const ORIGIN = 'https://console.test';
const RELAY_TOKEN = 'relay-token-that-is-long-enough-for-tests-012345';
const CLAIM_A = '11111111-1111-4111-8111-111111111111';
const CLAIM_B = '22222222-2222-4222-8222-222222222222';
const TICKET_KEY = Buffer.alloc(32, 7);
const RELAY_INSTANCE_ID = 'a'.repeat(64);
const RELAY_BOOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let database: TestDatabase;
let pool: DatabasePool;
let app!: FastifyInstance;
let directory!: string;

const requireFromGateway = createRequire(new URL('../../services/gateway/package.json', import.meta.url));
const Fastify = requireFromGateway('fastify') as (options: { logger: false }) => FastifyInstance;

async function build(maxSessionsPerOperator: number): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-admission-'));
  const grantsFile = join(directory, 'grants.json');
  await writeFile(grantsFile, JSON.stringify({
    version: 1,
    grants: [
      { operator: '*', tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] },
      { operator: '*', tenant_id: 'Steven', alias: 'socrates', modes: ['shell'] },
    ],
  }));
  const config: TerminalConfig = {
    wsPath: '/v3/console/terminal/ws', ticketKey: TICKET_KEY, relayToken: RELAY_TOKEN,
    relayInstanceIds: new Set([RELAY_INSTANCE_ID]),
    grantsFile, ticketTtlSeconds: 30, sessionTtlSeconds: 900, claimLeaseSeconds: 150,
    maxSessionsPerOperator,
    operatorHeader: 'x-cauce-operator', operators: new Set(['steven', 'miguel']),
  };
  const principal: Principal = {
    tenant_id: 'Steven', alias: 'kant', session_id: 'session', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'],
  };
  const registry = new AgentRegistry();
  registry.observe({ relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: RELAY_BOOT_ID }, [
    {
      tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-test',
      image_id: `sha256:${'a'.repeat(64)}`, runtime_user: 'claw', runtime_uid: 1000,
      harness: 'openclaw', modes: ['shell'], connected_since: new Date().toISOString(),
    },
    {
      tenant_id: 'Steven', alias: 'socrates', container_id: 'claw', generation: 'gen-test',
      image_id: `sha256:${'b'.repeat(64)}`, runtime_user: 'claw', runtime_uid: 1000,
      harness: 'codex', modes: ['shell'], connected_since: new Date().toISOString(),
    },
  ]);
  app = Fastify({ logger: false });
  app.addHook('preValidation', async (request) => {
    if (!request.url.startsWith('/v3/terminal/relay/')) return;
    if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) return;
    const body = request.body as Record<string, unknown>;
    body.relay_instance_id ??= RELAY_INSTANCE_ID;
    body.relay_boot_id ??= RELAY_BOOT_ID;
  });
  app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: [ORIGIN] }));
  await app.register(registerTerminalControlPlane, {
    pool,
    authProvider: {
      name: 'postgres-test', mode: 'test',
      authenticateHttp: async () => principal,
      authenticateHello: async () => principal,
    },
    config,
    registry,
    repository: {
      assertPermission: async () => undefined,
      authorizeAgentTarget: async (_actorTenant, _actorAlias, targetTenant, targetAlias) => {
        if (targetTenant !== 'Steven' || !['jarvis', 'socrates'].includes(targetAlias)) return undefined;
        return {
          tenant_id: targetTenant,
          alias: targetAlias,
          harness_id: null,
          home_directory: null,
          enabled: true,
        };
      },
    },
    measuredFacts: { factsFor: async () => undefined },
    governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'not needed' }) },
    relayPeerInstanceId: () => RELAY_INSTANCE_ID,
  });
  await app.ready();
}

async function request(
  operator: string | undefined,
  alias = 'jarvis',
  reason = 'probar admisión concurrente real',
  receipt: { requestId?: string; ownerToken?: string } = {},
) {
  return app.inject({
    method: 'POST', url: '/v3/console/terminal/sessions',
    headers: { origin: ORIGIN, ...(operator === undefined ? {} : { 'x-cauce-operator': operator }) },
    payload: {
      tenant_id: 'Steven', alias, mode: 'shell',
      reason, cols: 100, rows: 30,
      request_id: receipt.requestId ?? randomUUID(), owner_token: receipt.ownerToken ?? randomUUID(),
    },
  });
}

async function consume(sessionId: string, ticket: string, claimToken = CLAIM_A) {
  return app.inject({
    method: 'POST',
    url: `/v3/terminal/relay/sessions/${sessionId}/consume`,
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    payload: { ticket, claim_token: claimToken },
  });
}

async function resume(
  sessionId: string,
  resumeToken: string,
  claimToken: string,
  claimEpoch?: string,
) {
  return app.inject({
    method: 'POST',
    url: `/v3/terminal/relay/sessions/${sessionId}/resume`,
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    payload: {
      resume_token: resumeToken,
      claim_token: claimToken,
      ...(claimEpoch === undefined ? {} : { claim_epoch: claimEpoch }),
    },
  });
}

async function closeClaim(sessionId: string, claimToken?: string, claimEpoch?: string) {
  return app.inject({
    method: 'POST',
    url: `/v3/terminal/relay/sessions/${sessionId}/close`,
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    payload: {
      reason: 'relay test close', exit_code: null, bytes_in: 11, bytes_out: 22,
      ...(claimToken === undefined ? {} : { claim_token: claimToken }),
      ...(claimEpoch === undefined ? {} : { claim_epoch: claimEpoch }),
    },
  });
}

async function failAuditAction(action: string): Promise<void> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION cauce_test_terminal_audit_fail() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced terminal audit failure'; END $$;
    DROP TRIGGER IF EXISTS cauce_test_terminal_audit_fail ON audit_events;
    CREATE TRIGGER cauce_test_terminal_audit_fail BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = '${action}')
      EXECUTE FUNCTION cauce_test_terminal_audit_fail();
  `);
}

async function allowAuditAgain(): Promise<void> {
  await pool.query('DROP TRIGGER IF EXISTS cauce_test_terminal_audit_fail ON audit_events');
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  // terminal_sessions predates the shared reset table list and is intentionally independent of
  // message delivery state. This suite owns its rows, so clear them explicitly between races.
  await pool.query('TRUNCATE TABLE terminal_sessions');
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
      home_directory,state_directory
    ) VALUES
      ('Steven','kant','codex','Kant',true,'ctrl-infra','dev','/home/dev','/state/kant'),
      ('Steven','jarvis','openclaw','Jarvis',true,'claw','claw','/home/claw','/state/jarvis'),
      ('Steven','socrates','codex','Socrates',true,'claw','claw','/home/claw','/state/socrates');
  `);
  // Makes the historical COUNT/COUNT/INSERT implementation fail deterministically: both callers
  // finish their counts before either insert returns. The fixed one-statement admission keeps its
  // advisory lock through this trigger, so the second caller re-evaluates after the first commit.
  await pool.query(`
    CREATE OR REPLACE FUNCTION cauce_test_terminal_insert_delay() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$;
    DROP TRIGGER IF EXISTS cauce_test_terminal_insert_delay ON terminal_sessions;
    CREATE TRIGGER cauce_test_terminal_insert_delay BEFORE INSERT ON terminal_sessions
      FOR EACH ROW EXECUTE FUNCTION cauce_test_terminal_insert_delay();
  `);
});

afterEach(async () => {
  await app.close();
  await rm(directory, { recursive: true, force: true });
  await pool.query('DROP TRIGGER IF EXISTS cauce_test_terminal_insert_delay ON terminal_sessions');
  await pool.query('DROP TRIGGER IF EXISTS cauce_test_terminal_audit_fail ON audit_events');
  await pool.query('DROP FUNCTION IF EXISTS cauce_test_terminal_audit_fail()');
});

afterAll(async () => {
  await pool.query('DROP FUNCTION IF EXISTS cauce_test_terminal_insert_delay()');
  await pool.end();
  await database.container.stop();
});

describe('atomic PTY admission', () => {
  it('admits only one concurrent request at the per-operator limit', async () => {
    await build(1);
    const responses = await Promise.all([
      request('steven', 'jarvis', 'primera tarea concurrente real'),
      request('steven', 'jarvis', 'segunda tarea concurrente real'),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json())
      .toEqual({ error: 'conflict', reason: 'session_limit' });
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM terminal_sessions');
    expect(count.rows[0]?.count).toBe('1');
  });

  it('returns one durable issuance receipt to concurrent exact retries', async () => {
    await build(1);
    const receipt = { requestId: randomUUID(), ownerToken: randomUUID() };
    const responses = await Promise.all([request('steven', 'jarvis', 'probar admisión concurrente real', receipt), request('steven', 'jarvis', 'probar admisión concurrente real', receipt)]);
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    const receipts = responses.map((response) => response.json<{
      session_id: string; ticket: string; receipt_recovered: boolean;
    }>());
    expect(new Set(receipts.map((receipt) => receipt.session_id)).size).toBe(1);
    expect(new Set(receipts.map((receipt) => receipt.ticket)).size).toBe(1);
    expect(receipts.map((receipt) => receipt.receipt_recovered).sort()).toEqual([false, true]);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM terminal_sessions',
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('admits and lists the unattributed subject scope with a PostgreSQL-safe lock key', async () => {
    await build(1);
    const ownerToken = randomUUID();
    const requestId = randomUUID();
    const opened = await request(undefined, 'jarvis', 'probar admisión concurrente real', {
      requestId, ownerToken,
    });
    expect(opened.statusCode).toBe(201);
    const issued = opened.json<{ session_id: string; request_id: string; owner_generation: string }>();
    const stored = await pool.query<{ operator_id: string; console_subject: string }>(
      'SELECT operator_id,console_subject FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    expect(stored.rows[0]).toEqual({
      operator_id: 'unattributed:console-basic-auth',
      console_subject: 'Steven:kant',
    });
    await pool.query(
      `UPDATE terminal_sessions
          SET console_subject='Steven:socrates', container='detached-test-container'
        WHERE id=$1`,
      [issued.session_id],
    );
    const listed = await app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(listed.json()).toEqual({ items: [] });
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${issued.session_id}`,
      headers: { origin: ORIGIN },
      payload: {
        request_id: issued.request_id,
        owner_generation: issued.owner_generation,
        owner_token: ownerToken,
      },
    });
    expect(revoke.statusCode).toBe(409);
    const untouched = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    expect(untouched.rows[0]?.revoked_at).toBeNull();
    expect((await request(undefined, 'jarvis', 'tarea del sujeto de consola actual')).statusCode).toBe(201);
  });

  it('reconstructs the exact issuance receipt across a real gateway restart', async () => {
    await build(10);
    const receipt = { requestId: randomUUID(), ownerToken: randomUUID() };
    const first = await request('steven', 'jarvis', 'probar admisión concurrente real', receipt);
    expect(first.statusCode).toBe(201);
    const original = first.json<{ session_id: string; ticket: string }>();

    await app.close();
    await rm(directory, { recursive: true, force: true });
    await build(10);
    const retried = await request('steven', 'jarvis', 'probar admisión concurrente real', receipt);
    expect(retried.statusCode).toBe(201);
    expect(retried.json()).toMatchObject({
      session_id: original.session_id,
      ticket: original.ticket,
      receipt_recovered: true,
    });
  });

  it('rolls back real issuance when its audit write fails', async () => {
    await build(10);
    await failAuditAction('terminal.session.request');
    const failed = await request('steven');
    expect(failed.statusCode).toBe(400);
    const absent = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM terminal_sessions',
    );
    expect(absent.rows[0]?.count).toBe('0');

    await allowAuditAgain();
    expect((await request('steven')).statusCode).toBe(201);
  });

  it('admits only one operator into a shared physical container', async () => {
    await build(10);
    const responses = await Promise.all([request('steven'), request('miguel')]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json())
      .toEqual({ error: 'conflict', reason: 'container_busy' });
  });

  it('admits only one alias in the physical container even for the same operator', async () => {
    await build(10);
    const responses = await Promise.all([request('steven', 'jarvis'), request('steven', 'socrates')]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json())
      .toEqual({ error: 'conflict', reason: 'container_busy' });
  });

  it('lists slot occupancy with the exact PostgreSQL predicate and database clock', async () => {
    await build(1);
    const opened = await request('steven');
    expect(opened.statusCode).toBe(201);
    const sessionId = opened.json<{ session_id: string }>().session_id;
    const list = () => app.inject({
      method: 'GET',
      url: '/v3/console/terminal/sessions',
      headers: { 'x-cauce-operator': 'steven' },
    });

    const live = await list();
    expect(live.statusCode).toBe(200);
    expect(live.json<{ items: { session_id: string; state: string }[] }>().items).toEqual([
      expect.objectContaining({ session_id: sessionId, state: 'issued' }),
    ]);

    await pool.query(
      `UPDATE terminal_sessions SET expires_at=now() - interval '1 second' WHERE id=$1`,
      [sessionId],
    );
    const expired = await list();
    expect(expired.json<{ items: { session_id: string; state: string }[] }>().items).toEqual([
      expect.objectContaining({ session_id: sessionId, state: 'closed' }),
    ]);
  });

  it('binds signed ticket and live authorization to real PostgreSQL timestamps', async () => {
    await build(10);
    const opened = await request('steven');
    expect(opened.statusCode).toBe(201);
    const issued = opened.json<{ session_id: string; ticket: string; expires_at: string }>();
    const stored = await pool.query<{ issued_at: Date; expires_at: Date }>(
      'SELECT issued_at, expires_at FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error('Expected terminal session row');
    expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(30_000);
    expect(issued.expires_at).toBe(row.expires_at.toISOString());
    expect(verifyTicketSignature(
      issued.ticket,
      deriveAliasKey(TICKET_KEY, 'Steven', 'jarvis'),
    )).toMatchObject({
      iat: Math.floor(row.issued_at.getTime() / 1_000),
      exp: Math.floor(row.expires_at.getTime() / 1_000),
    });

    const consumed = await app.inject({
      method: 'POST',
      url: `/v3/terminal/relay/sessions/${issued.session_id}/consume`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: { ticket: issued.ticket, claim_token: CLAIM_A },
    });
    expect(consumed.statusCode).toBe(200);
    await pool.query(
      `UPDATE terminal_sessions
          SET consumed_at=now() - make_interval(secs => 901)
        WHERE id=$1`,
      [issued.session_id],
    );
    const authz = await app.inject({
      method: 'POST',
      url: `/v3/terminal/relay/sessions/${issued.session_id}/authz`,
      headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      payload: {
        claim_token: CLAIM_A,
        claim_epoch: consumed.json<{ claim_epoch: string }>().claim_epoch,
      },
    });
    expect(authz.statusCode).toBe(403);
    expect(authz.json()).toEqual({ ok: false, reason: 'session_expired' });
  });

  it('serializes concurrent exact consumes into one transition and one recovered receipt', async () => {
    await build(10);
    const opened = await request('steven');
    const issued = opened.json<{ session_id: string; ticket: string }>();
    const responses = await Promise.all([
      consume(issued.session_id, issued.ticket),
      consume(issued.session_id, issued.ticket),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.map((response) =>
      response.json<{ receipt_recovered: boolean }>().receipt_recovered).sort()).toEqual([false, true]);
    const lifecycle = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    expect(lifecycle.rows[0]?.consumed_at).toBeInstanceOf(Date);
    const audit = await pool.query<{ recovered: boolean }>(
      `SELECT (metadata->>'receipt_recovered')::boolean AS recovered
         FROM audit_events
        WHERE action='terminal.session.consume' AND metadata->>'session_id'=$1
        ORDER BY id`,
      [issued.session_id],
    );
    expect(audit.rows.map((row) => row.recovered).sort()).toEqual([false, true]);
  });

  it('rolls back real consume when audit fails and recovers with the same ticket', async () => {
    await build(10);
    const opened = await request('steven');
    const issued = opened.json<{ session_id: string; ticket: string }>();
    await failAuditAction('terminal.session.consume');

    const failed = await consume(issued.session_id, issued.ticket);
    expect(failed.statusCode).toBe(400);
    const unconsumed = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    expect(unconsumed.rows[0]?.consumed_at).toBeNull();

    await allowAuditAgain();
    const retried = await consume(issued.session_id, issued.ticket);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ ok: true, receipt_recovered: false });
  });

  it('keeps a pre-closed row unconsumed under the real closed-aware lifecycle predicate', async () => {
    await build(10);
    const opened = await request('steven');
    const issued = opened.json<{ session_id: string; ticket: string }>();
    await pool.query('UPDATE terminal_sessions SET closed_at=now() WHERE id=$1', [issued.session_id]);

    const refused = await consume(issued.session_id, issued.ticket);
    expect(refused.statusCode).toBe(401);
    const lifecycle = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    expect(lifecycle.rows[0]?.consumed_at).toBeNull();
  });

  it('serializes two relay claims, rotates the fence after expiry and ignores a stale spooled close', async () => {
    await build(10);
    const opened = await request('steven');
    const issued = opened.json<{ session_id: string; ticket: string }>();
    const attempts = await Promise.all([
      consume(issued.session_id, issued.ticket, CLAIM_A),
      consume(issued.session_id, issued.ticket, CLAIM_B),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const granted = attempts.find((response) => response.statusCode === 200);
    const conflict = attempts.find((response) => response.statusCode === 409);
    if (!granted || !conflict) throw new Error('Expected granted and conflict responses');
    expect(conflict.json()).toMatchObject({ ok: false, reason: 'claim_conflict' });
    expect(conflict.json<{ retry_after_ms: number }>().retry_after_ms).toBeGreaterThan(0);
    const first = granted.json<{ claim_token: string; claim_epoch: string }>();
    expect(first.claim_epoch).toBe('1');
    const nextClaim = first.claim_token === CLAIM_A ? CLAIM_B : CLAIM_A;

    await pool.query(
      `UPDATE terminal_sessions SET relay_claim_expires_at=clock_timestamp()-interval '1 millisecond'
        WHERE id=$1`,
      [issued.session_id],
    );
    const takeover = await consume(issued.session_id, issued.ticket, nextClaim);
    expect(takeover.statusCode).toBe(200);
    expect(takeover.json()).toMatchObject({
      claim_token: nextClaim, claim_epoch: '2', claim_taken_over: true,
    });

    const staleClose = await closeClaim(issued.session_id, first.claim_token, first.claim_epoch);
    expect(staleClose.statusCode).toBe(200);
    const stillOpen = await pool.query<{
      closed_at: Date | null;
      relay_claim_epoch: string;
      digest_matches: boolean;
    }>(
      `SELECT closed_at,relay_claim_epoch::text,
              relay_claim_sha256=digest($2,'sha256') AS digest_matches
         FROM terminal_sessions WHERE id=$1`,
      [issued.session_id, nextClaim],
    );
    expect(stillOpen.rows[0]).toEqual({
      closed_at: null, relay_claim_epoch: '2', digest_matches: true,
    });
    const staleAudit = await pool.query<{ reason: string }>(
      `SELECT metadata->>'reason' AS reason FROM audit_events
        WHERE action='terminal.session.close' AND decision='deny'
          AND metadata->>'session_id'=$1 ORDER BY id DESC LIMIT 1`,
      [issued.session_id],
    );
    expect(staleAudit.rows[0]?.reason).toBe('stale_claim');

    const exactClose = await closeClaim(issued.session_id, nextClaim, '2');
    expect(exactClose.statusCode).toBe(200);
    const closed = await pool.query<{ closed_at: Date | null; relay_claim_epoch: string }>(
      `SELECT closed_at,relay_claim_epoch::text FROM terminal_sessions WHERE id=$1`,
      [issued.session_id],
    );
    expect(closed.rows[0]?.closed_at).toBeInstanceOf(Date);
    expect(closed.rows[0]?.relay_claim_epoch).toBe('2');
    const leaked = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE metadata::text LIKE '%'||$1||'%' OR metadata::text LIKE '%'||$2||'%'`,
      [CLAIM_A, CLAIM_B],
    );
    expect(leaked.rows[0]?.count).toBe('0');
  });

  it('renews only the exact resume claim and permits a new replica takeover only after expiry', async () => {
    await build(10);
    const opened = await request('steven');
    const issued = opened.json<{ session_id: string; ticket: string }>();
    const consumed = await consume(issued.session_id, issued.ticket, CLAIM_A);
    const first = consumed.json<{ resume_token: string; claim_epoch: string }>();

    const exact = await resume(issued.session_id, first.resume_token, CLAIM_A, first.claim_epoch);
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({ claim_token: CLAIM_A, claim_epoch: '1' });
    const otherReplica = await resume(issued.session_id, first.resume_token, CLAIM_B);
    expect(otherReplica.statusCode).toBe(409);
    expect(otherReplica.json()).toMatchObject({ reason: 'claim_conflict' });

    await pool.query(
      `UPDATE terminal_sessions SET relay_claim_expires_at=clock_timestamp()-interval '1 millisecond'
        WHERE id=$1`,
      [issued.session_id],
    );
    const recovered = await resume(issued.session_id, first.resume_token, CLAIM_B);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      claim_token: CLAIM_B, claim_epoch: '2', claim_taken_over: true,
    });
  });

  it('rolls back an exact close when its audit fails, then drains a legacy epoch-zero row', async () => {
    await build(10);
    const opened = await request('steven');
    const issued = opened.json<{ session_id: string; ticket: string }>();
    const consumed = await consume(issued.session_id, issued.ticket, CLAIM_A);
    const epoch = consumed.json<{ claim_epoch: string }>().claim_epoch;
    await failAuditAction('terminal.session.close');

    const failed = await closeClaim(issued.session_id, CLAIM_A, epoch);
    expect(failed.statusCode).toBe(400);
    const rolledBack = await pool.query<{ closed_at: Date | null }>(
      'SELECT closed_at FROM terminal_sessions WHERE id=$1',
      [issued.session_id],
    );
    expect(rolledBack.rows[0]?.closed_at).toBeNull();
    await allowAuditAgain();
    expect((await closeClaim(issued.session_id, CLAIM_A, epoch)).statusCode).toBe(200);

    const legacyOpened = await request('steven', 'socrates', 'drenar spool legacy sin fence');
    const legacy = legacyOpened.json<{ session_id: string }>();
    await pool.query(
      'UPDATE terminal_sessions SET consumed_at=clock_timestamp() WHERE id=$1',
      [legacy.session_id],
    );
    expect((await closeClaim(legacy.session_id)).statusCode).toBe(200);
    const legacyClosed = await pool.query<{ closed_at: Date | null; relay_claim_epoch: string }>(
      `SELECT closed_at,relay_claim_epoch::text FROM terminal_sessions WHERE id=$1`,
      [legacy.session_id],
    );
    expect(legacyClosed.rows[0]?.closed_at).toBeInstanceOf(Date);
    expect(legacyClosed.rows[0]?.relay_claim_epoch).toBe('0');
  });

  it('refuses issuance against real PostgreSQL when the gateway clock exceeds tolerance', async () => {
    await build(10);
    const actualNow = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(actualNow + 10_000);
    try {
      const response = await request('steven');
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: 'terminal_clock_skew' });
      const count = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM terminal_sessions',
      );
      expect(count.rows[0]?.count).toBe('0');
    } finally {
      clock.mockRestore();
    }
  });
});
