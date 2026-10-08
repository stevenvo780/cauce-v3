import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import {
  FixedAuthProvider, buildTestGateway, grants, roles, testPrincipal,
} from '../gateway-hardening/helpers.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
const apps: FastifyInstance[] = [];

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Isa','salva'),('Steven','argos') ON CONFLICT DO NOTHING");
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

async function operatorGateway(): Promise<FastifyInstance> {
  const app = await buildTestGateway({
    pool,
    repository: new CauceRepository(pool),
    authProvider: new FixedAuthProvider(testPrincipal({
      tenant_id: 'Steven', alias: 'kant', roles: roles('operator'), permissions: grants('read', 'control'),
    })),
  });
  apps.push(app);
  return app;
}

const headers = { origin: 'http://localhost' };
const look = { glyph: '\u{1F989}', hue: 30, style: 'aurora', expected_revision: null };

async function edge(change: string): Promise<void> {
  await pool.query(`UPDATE acl_edges SET ${change} WHERE from_tenant='Steven' AND to_tenant='Isa'`);
}

async function stored(): Promise<number> {
  return Number((await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM agent_appearances')).rows[0]?.total);
}

describe('agent appearance authorization through the real ACL', () => {
  it('refuses a read-only edge with 403, audits it, and writes once the edge grants control', async () => {
    const app = await operatorGateway();
    await edge('enabled=true,allow_read=true,allow_control=false');
    const url = '/v3/console/agents/Isa/salva/appearance';
    const denied = await app.inject({ method: 'PUT', url, headers, payload: look });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'forbidden' });
    const reset = await app.inject({ method: 'DELETE', url: `${url}?expected_revision=1`, headers });
    expect(reset.statusCode).toBe(403);
    expect(await stored()).toBe(0);
    const visible = await app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers });
    expect(visible.statusCode).toBe(200);

    await edge('allow_control=true');
    const saved = await app.inject({ method: 'PUT', url, headers, payload: look });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ tenant_id: 'Isa', alias: 'salva', revision: 1, style: 'aurora' });
    const listed = await app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers });
    expect(listed.json<{ appearances: { alias: string }[] }>().appearances.map((item) => item.alias)).toEqual(['salva']);

    await edge('allow_control=false');
    const resetDenied = await app.inject({ method: 'DELETE', url: `${url}?expected_revision=1`, headers });
    expect(resetDenied.statusCode).toBe(403);
    expect(await stored()).toBe(1);

    const audit = await pool.query<{ action: string; decision: string; tenant_id: string; reason: string | null }>(
      `SELECT action,decision,tenant_id,metadata->>'reason' AS reason FROM audit_events
        WHERE action LIKE 'agent_appearance.%' ORDER BY id`,
    );
    expect(audit.rows).toEqual([
      { action: 'agent_appearance.denied', decision: 'deny', tenant_id: 'Steven', reason: 'forbidden' },
      { action: 'agent_appearance.denied', decision: 'deny', tenant_id: 'Steven', reason: 'forbidden' },
      { action: 'agent_appearance.set', decision: 'allow', tenant_id: 'Steven', reason: null },
      { action: 'agent_appearance.denied', decision: 'deny', tenant_id: 'Steven', reason: 'forbidden' },
    ]);
  });

  it('hides agents behind a disabled edge from writes and from the preference lists alike', async () => {
    const app = await operatorGateway();
    await pool.query(`INSERT INTO agent_appearances(tenant_id,alias,style,updated_by)
      VALUES('Isa','salva','orb','Fixture')`);
    await edge('enabled=false');
    const write = await app.inject({
      method: 'PUT', url: '/v3/console/agents/Isa/salva/appearance', headers, payload: { ...look, expected_revision: 1 },
    });
    expect(write.statusCode).toBe(404);
    const favorite = await app.inject({ method: 'PUT', url: '/v3/console/favorites/Isa/salva', headers });
    expect(favorite.statusCode).toBe(401);
    const listed = await app.inject({ method: 'GET', url: '/v3/console/agent-preferences', headers });
    expect(listed.json()).toEqual({ favorites: [], appearances: [] });
    const own = await app.inject({
      method: 'PUT', url: '/v3/console/agents/Steven/argos/appearance', headers, payload: look,
    });
    expect(own.statusCode).toBe(200);
  });
});
