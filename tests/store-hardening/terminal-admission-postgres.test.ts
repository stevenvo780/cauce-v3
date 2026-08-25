import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { FastifyInstance } from '../../services/gateway/node_modules/fastify/types/instance.js';
import type { Principal } from '../../services/gateway/src/auth.js';
import { createConsoleSecurityHook } from '../../services/gateway/src/console-security.js';
import type { TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { AgentRegistry } from '../../services/gateway/src/terminal/registry.js';
import type { DatabasePool } from '@cauce/store';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

const ORIGIN = 'https://console.test';
const RELAY_TOKEN = 'relay-token-that-is-long-enough-for-tests-012345';
let database: TestDatabase;
let pool: DatabasePool;
let app: FastifyInstance;
let directory: string;

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
    wsPath: '/v3/console/terminal/ws', ticketKey: Buffer.alloc(32, 7), relayToken: RELAY_TOKEN,
    grantsFile, ticketTtlSeconds: 30, sessionTtlSeconds: 900, maxSessionsPerOperator,
    operatorHeader: 'x-cauce-operator', operators: new Set(['steven', 'miguel']),
  };
  const principal: Principal = {
    tenant_id: 'Steven', alias: 'kant', session_id: 'session', channel: 'console',
    roles: ['operator'], permissions: ['route', 'read', 'control'],
  };
  const registry = new AgentRegistry();
  registry.observe([
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
    repository: { assertPermission: async () => undefined },
    measuredFacts: { factsFor: async () => undefined },
    governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'not needed' }) },
  });
  await app.ready();
}

async function request(operator: string, alias = 'jarvis') {
  return app.inject({
    method: 'POST', url: '/v3/console/terminal/sessions',
    headers: { origin: ORIGIN, 'x-cauce-operator': operator },
    payload: {
      tenant_id: 'Steven', alias, mode: 'shell',
      reason: 'probar admisión concurrente real', cols: 100, rows: 30,
    },
  });
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
  if (app) await app.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  await pool.query('DROP TRIGGER IF EXISTS cauce_test_terminal_insert_delay ON terminal_sessions');
});

afterAll(async () => {
  if (pool) {
    await pool.query('DROP FUNCTION IF EXISTS cauce_test_terminal_insert_delay()');
    await pool.end();
  }
  if (database?.container) await database.container.stop();
});

describe('atomic PTY admission', () => {
  it('admits only one concurrent request at the per-operator limit', async () => {
    await build(1);
    const responses = await Promise.all([request('steven'), request('steven')]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json())
      .toEqual({ error: 'conflict', reason: 'session_limit' });
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM terminal_sessions');
    expect(count.rows[0]?.count).toBe('1');
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
});
