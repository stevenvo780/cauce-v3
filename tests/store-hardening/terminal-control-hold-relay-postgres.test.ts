import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from '../../services/gateway/node_modules/fastify/types/instance.js';
import type { Principal } from '../../services/gateway/src/auth.js';
import { createConsoleSecurityHook } from '../../services/gateway/src/console-security.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import type { DatabasePool } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

/**
 * The control hold read by the THREE relay routes that hand a grant back. `/authz` already refused
 * a writable session whose hold was given back; `/consume` and `/resume` did not, so a relay that
 * reconnected between the release and the close report got a fresh `harness_rw` grant and died on
 * its next authorization with a 4410. Every case here runs against real PostgreSQL rows.
 */

const ORIGIN = 'https://console.test';
const RELAY_TOKEN = 'relay-token-that-is-long-enough-for-tests-012345';
const CLAIM = '11111111-1111-4111-8111-111111111111';
const TICKET_KEY = Buffer.alloc(32, 7);
const RELAY_INSTANCE_ID = 'c'.repeat(64);
const RELAY_BOOT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let app!: FastifyInstance;
let directory!: string;

const requireFromGateway = createRequire(new URL('../../services/gateway/package.json', import.meta.url));
const Fastify = requireFromGateway('fastify') as (options: { logger: false }) => FastifyInstance;

async function build(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'cauce-terminal-hold-'));
  const grantsFile = join(directory, 'grants.json');
  await writeFile(grantsFile, JSON.stringify({
    version: 1,
    grants: [{
      operator: 'steven', tenant_id: 'Steven', alias: 'jarvis',
      modes: ['shell', 'harness', 'harness_rw'],
    }],
  }));
  const config: TerminalConfig = {
    wsPath: '/v3/console/terminal/ws', ticketKey: TICKET_KEY, relayToken: RELAY_TOKEN,
    relayInstanceIds: new Set([RELAY_INSTANCE_ID]),
    grantsFile, ticketTtlSeconds: 30, sessionTtlSeconds: 900, claimLeaseSeconds: 150,
    maxSessionsPerOperator: 10,
    operatorHeader: 'x-cauce-operator', operators: new Set(['steven']),
  };
  const principal: Principal = {
    tenant_id: 'Steven', alias: 'kant', session_id: 'session', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'],
  };
  const registry = new AgentRegistry();
  registry.observe({ relay_instance_id: RELAY_INSTANCE_ID, relay_boot_id: RELAY_BOOT_ID }, [{
    tenant_id: 'Steven', alias: 'jarvis', container_id: 'claw', generation: 'gen-test',
    image_id: `sha256:${'a'.repeat(64)}`, runtime_user: 'claw', runtime_uid: 1000,
    harness: 'openclaw', modes: ['shell'], connected_since: new Date().toISOString(),
  }]);
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
    measuredFacts: { factsFor: async () => undefined },
    governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'not needed' }) },
    relayPeerInstanceId: () => RELAY_INSTANCE_ID,
  });
  await app.ready();
}

async function abrirSesion(): Promise<{ session_id: string; ticket: string }> {
  const opened = await app.inject({
    method: 'POST', url: '/v3/console/terminal/sessions',
    headers: { origin: ORIGIN, 'x-cauce-operator': 'steven' },
    payload: {
      tenant_id: 'Steven', alias: 'jarvis', mode: 'shell',
      reason: 'probar el arriendo del control en el relay', cols: 100, rows: 30,
      request_id: randomUUID(), owner_token: randomUUID(),
    },
  });
  expect(opened.statusCode).toBe(201);
  return opened.json<{ session_id: string; ticket: string }>();
}

async function consume(sessionId: string, ticket: string) {
  return app.inject({
    method: 'POST',
    url: `/v3/terminal/relay/sessions/${sessionId}/consume`,
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    payload: { ticket, claim_token: CLAIM },
  });
}

async function resume(sessionId: string, resumeToken: string, claimEpoch: string) {
  return app.inject({
    method: 'POST',
    url: `/v3/terminal/relay/sessions/${sessionId}/resume`,
    headers: { authorization: `Bearer ${RELAY_TOKEN}` },
    payload: { resume_token: resumeToken, claim_token: CLAIM, claim_epoch: claimEpoch },
  });
}

async function modo(sessionId: string, valor: 'harness' | 'harness_rw'): Promise<void> {
  await pool.query('UPDATE terminal_sessions SET mode=$2 WHERE id=$1', [sessionId, valor]);
}

async function tomarArriendo(sessionId: string): Promise<string> {
  const taken = await pool.query<{ id: string }>(
    `INSERT INTO terminal_control_holds(
       session_id,tenant_id,alias,operator_id,reason,taken_at,expires_at
     ) VALUES($1,'Steven','jarvis','steven','tomar la TUI para desatascar el turno',
       now(),now()+make_interval(secs => 300))
     RETURNING id`,
    [sessionId],
  );
  const row = taken.rows[0];
  if (row === undefined) throw new Error('the control hold was not inserted');
  return row.id;
}

async function devolverArriendo(holdId: string): Promise<void> {
  await pool.query(
    `UPDATE terminal_control_holds SET released_at=now(),released_reason='operator_released'
      WHERE id=$1`,
    [holdId],
  );
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE TABLE terminal_sessions CASCADE');
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
      home_directory,state_directory
    ) VALUES
      ('Steven','kant','codex','Kant',true,'ctrl-infra','dev','/home/dev','/state/kant'),
      ('Steven','jarvis','openclaw','Jarvis',true,'claw','claw','/home/claw','/state/jarvis');
  `);
  await build();
});

afterEach(async () => {
  if (!databaseStarted) return;
  await app.close();
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('el arriendo del control cierra las tres rutas del relay', () => {
  it('el resume no revive una sesión escribible cuyo control ya se devolvió', async () => {
    const issued = await abrirSesion();
    const consumed = await consume(issued.session_id, issued.ticket);
    const primero = consumed.json<{ resume_token: string; claim_epoch: string }>();
    await modo(issued.session_id, 'harness_rw');

    const sinArriendo = await resume(issued.session_id, primero.resume_token, primero.claim_epoch);
    expect(sinArriendo.statusCode).toBe(200);

    const holdId = await tomarArriendo(issued.session_id);
    const conArriendo = await resume(issued.session_id, primero.resume_token, primero.claim_epoch);
    expect(conArriendo.statusCode).toBe(200);

    await devolverArriendo(holdId);
    const devuelto = await resume(issued.session_id, primero.resume_token, primero.claim_epoch);
    expect(devuelto.statusCode).toBe(403);
    expect(devuelto.json()).toEqual({ ok: false, reason: 'control_released' });
  });

  it('el consume no recupera una sesión escribible cuyo control ya se devolvió', async () => {
    const issued = await abrirSesion();
    expect((await consume(issued.session_id, issued.ticket)).statusCode).toBe(200);
    await modo(issued.session_id, 'harness_rw');

    const holdId = await tomarArriendo(issued.session_id);
    expect((await consume(issued.session_id, issued.ticket)).statusCode).toBe(200);

    await devolverArriendo(holdId);
    const devuelto = await consume(issued.session_id, issued.ticket);
    expect(devuelto.statusCode).toBe(403);
    expect(devuelto.json()).toEqual({ ok: false, reason: 'control_released' });
  });

  it('una sesión de sólo lectura reanuda y reconsume con el arriendo de su alias devuelto', async () => {
    const issued = await abrirSesion();
    const consumed = await consume(issued.session_id, issued.ticket);
    const primero = consumed.json<{ resume_token: string; claim_epoch: string }>();
    await modo(issued.session_id, 'harness');
    const holdId = await tomarArriendo(issued.session_id);
    await devolverArriendo(holdId);

    expect((await resume(issued.session_id, primero.resume_token, primero.claim_epoch)).statusCode)
      .toBe(200);
    expect((await consume(issued.session_id, issued.ticket)).statusCode).toBe(200);
  });

  it('una sesión escribible que nunca tuvo arriendo sigue reanudando', async () => {
    const issued = await abrirSesion();
    const consumed = await consume(issued.session_id, issued.ticket);
    const primero = consumed.json<{ resume_token: string; claim_epoch: string }>();
    await modo(issued.session_id, 'harness_rw');

    expect((await resume(issued.session_id, primero.resume_token, primero.claim_epoch)).statusCode)
      .toBe(200);
  });
});
