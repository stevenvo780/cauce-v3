import { preparePostgresSuite } from './postgres-suite.js';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { removeAgentContextRevisionsLayer } from './agent-context-revisions-layer.js';
import { removeSecretHandoffLayer } from './secret-handoff-layer.js';
import { removeTerminalControlHoldsLayer } from './terminal-control-holds-layer.js';
import {
  AgentProfileRepository, applyMigrationsThrough,
  type DatabasePool,
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabaseThrough, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

/**
 * Contract 028 against real Postgres.
 *
 * Testing the helper that trims is not enough: this suite crosses the three surfaces that
 * previously diverged —profile, legacy/templates column and delivery envelope— and also runs down/up.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
const ACTOR = { tenant_id: 'Steven', alias: 'kant' } as const;

const downPath = new URL('../migrations/down/028_canonical_agent_role.sql', import.meta.url);

async function runSql(url: URL): Promise<void> {
  await pool.query(await readFile(url, 'utf8'));
}

async function migrationApplied(): Promise<boolean> {
  const result = await pool.query<{ applied: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM schema_migrations WHERE version='028_canonical_agent_role.sql'
     ) AS applied`,
  );
  return result.rows[0]?.applied === true;
}

async function ensureUp(): Promise<void> {
  if (!(await migrationApplied())) await applyMigrationsThrough(pool, '043_blob_tenant_entitlements.sql');
}

async function ensureDown(): Promise<void> {
  if (!(await migrationApplied())) return;
  await removeAgentContextRevisionsLayer(pool);
  await removeTerminalControlHoldsLayer(pool);
  await removeSecretHandoffLayer(pool);
  await runSql(downPath);
}

async function insertAgent(
  tenant: string,
  alias: string,
  roleBrief: string | null = null,
  enabled = false,
): Promise<void> {
  await pool.query(
    `INSERT INTO agents(
       tenant_id,alias,harness_id,display_name,enabled,
       container_name,runtime_user,home_directory,state_directory,role_brief
     ) VALUES (
       $1,$2,'codex',$2,$3,
       CASE WHEN $3 THEN 'ws-' || $1 || '-' || $2 ELSE NULL END,
       CASE WHEN $3 THEN 'dev' ELSE NULL END,
       CASE WHEN $3 THEN '/home/dev' ELSE NULL END,
       CASE WHEN $3 THEN '/home/dev/.cauce' ELSE NULL END,
       $4
     )`,
    [tenant, alias, enabled, roleBrief],
  );
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough('043_blob_tenant_entitlements.sql');
  databaseStarted = true;
  pool = database.pool;
}, 180_000);

beforeEach(async () => {
  await ensureUp();
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE config_revisions RESTART IDENTITY CASCADE');
  await pool.query(`DELETE FROM agent_role_templates WHERE slug LIKE 'test_%'`);
});

afterAll(async () => {
  if (!databaseStarted) return;
  try {
    await ensureUp();
  } finally {
    await pool.end();
    await database.container.stop();
  }
});

describe('reconciliación y compatibilidad de la migración 028', () => {

  it('hace ganar el perfil existente y solo si falta perfil siembra el legacy', async () => {
    await ensureDown();
    await insertAgent('Steven', 'canonical', 'legacy que debe perder');
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,role_summary)
       VALUES ('Steven','canonical','rol rico canónico')`,
    );

    await insertAgent('Steven', 'seeded', '  legacy conservado  ');

    await insertAgent('Steven', 'explicit_null', 'legacy que no debe revivir');
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,purpose,role_summary)
       VALUES ('Steven','explicit_null','tiene perfil',NULL)`,
    );

    await insertAgent('Steven', 'blank', 'legacy que tampoco debe revivir');
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,role_summary)
       VALUES ('Steven','blank','   ')`,
    );

    await applyMigrationsThrough(pool, '043_blob_tenant_entitlements.sql');

    const rows = await pool.query<{
      alias: string; role_summary: string | null; role_brief: string | null;
    }>(
      `SELECT agent.alias,profile.role_summary,agent.role_brief
         FROM agents agent
         LEFT JOIN agent_profiles profile
           ON profile.tenant_id=agent.tenant_id AND profile.alias=agent.alias
        WHERE agent.tenant_id='Steven'
        ORDER BY agent.alias`,
    );
    expect(rows.rows).toEqual([
      { alias: 'blank', role_summary: null, role_brief: null },
      { alias: 'canonical', role_summary: 'rol rico canónico', role_brief: 'rol rico canónico' },
      { alias: 'explicit_null', role_summary: null, role_brief: null },
      { alias: 'seeded', role_summary: 'legacy conservado', role_brief: 'legacy conservado' },
    ]);

    const constraint = await pool.query<{ valid: boolean }>(
      `SELECT convalidated AS valid FROM pg_constraint
        WHERE conname='agent_profiles_role_summary_visible'`,
    );
    expect(constraint.rows).toEqual([{ valid: true }]);
  });
});

describe('una fuente canónica en todos los caminos de escritura', () => {
  it('sincroniza perfil, legacy y plantillas sin perder tenant+alias', async () => {
    await insertAgent('Steven', 'duplicado', null, true);
    await insertAgent('Miguel', 'duplicado', null, true);
    const profiles = new AgentProfileRepository(pool);

    await profiles.replace({
      tenant_id: 'Steven', alias: 'duplicado', role_summary: 'rol de Steven',
    }, null, ACTOR);
    await profiles.replace({
      tenant_id: 'Miguel', alias: 'duplicado', role_summary: 'rol de Miguel',
    }, null, { tenant_id: 'Miguel', alias: 'kant' });

    await pool.query(
      `UPDATE agents SET role_brief='legacy traducido'
        WHERE tenant_id='Miguel' AND alias='duplicado'`,
    );

    const rows = await pool.query<{
      tenant_id: string; role_summary: string; role_brief: string;
    }>(
      `SELECT agent.tenant_id,profile.role_summary,agent.role_brief
         FROM agents agent JOIN agent_profiles profile USING (tenant_id,alias)
        WHERE agent.alias='duplicado' ORDER BY agent.tenant_id`,
    );
    expect(rows.rows).toEqual([
      { tenant_id: 'Miguel', role_summary: 'legacy traducido', role_brief: 'legacy traducido' },
      { tenant_id: 'Steven', role_summary: 'rol de Steven', role_brief: 'rol de Steven' },
    ]);
  });

  it('propaga una plantilla y rompe explícitamente el vínculo al personalizar el perfil', async () => {
    await pool.query(
      `INSERT INTO agent_role_templates(slug,display_name,brief)
       VALUES ('test_builder','Constructor','construir con pruebas')`,
    );
    await insertAgent('Steven', 'builder', null, true);
    await pool.query(
      `UPDATE agents
          SET role_template_slug='test_builder',role_brief='construir con pruebas'
        WHERE tenant_id='Steven' AND alias='builder'`,
    );
    expect((await new AgentProfileRepository(pool).read('Steven', 'builder')).role_summary)
      .toBe('construir con pruebas');

    await pool.query(
      `UPDATE agent_role_templates SET brief='construir, probar y entregar',updated_at=now()
        WHERE slug='test_builder'`,
    );
    const propagated = await pool.query<{
      role_summary: string; role_brief: string; role_template_slug: string | null;
    }>(
      `SELECT profile.role_summary,agent.role_brief,agent.role_template_slug
         FROM agents agent JOIN agent_profiles profile USING (tenant_id,alias)
        WHERE agent.tenant_id='Steven' AND agent.alias='builder'`,
    );
    expect(propagated.rows).toEqual([{
      role_summary: 'construir, probar y entregar',
      role_brief: 'construir, probar y entregar',
      role_template_slug: 'test_builder',
    }]);

    const profiles = new AgentProfileRepository(pool);
    const existente = await profiles.readWithPresence('Steven', 'builder');
    await profiles.replace({
      tenant_id: 'Steven', alias: 'builder', role_summary: 'rol personalizado',
    }, existente.revision, ACTOR);
    const custom = await pool.query<{ role_brief: string; role_template_slug: string | null }>(
      `SELECT role_brief,role_template_slug FROM agents
        WHERE tenant_id='Steven' AND alias='builder'`,
    );
    expect(custom.rows).toEqual([{ role_brief: 'rol personalizado', role_template_slug: null }]);
  });

  it('dos editores con la misma revisión no se pisan: gana exactamente uno', async () => {
    await insertAgent('Steven', 'concurrente', null, true);
    const profiles = new AgentProfileRepository(pool);
    const actor = { tenant_id: 'Steven', alias: 'kant' };
    const first = profiles.replace({
      tenant_id: 'Steven', alias: 'concurrente', role_summary: 'editor uno',
    }, null, actor);
    const second = profiles.replace({
      tenant_id: 'Steven', alias: 'concurrente', role_summary: 'editor dos',
    }, null, actor);

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected', reason: { code: 'conflict' },
    });

    const final = await pool.query<{ role_summary: string; role_brief: string }>(
      `SELECT profile.role_summary,agent.role_brief
         FROM agents agent JOIN agent_profiles profile USING (tenant_id,alias)
        WHERE agent.tenant_id='Steven' AND agent.alias='concurrente'`,
    );
    expect(['editor uno', 'editor dos']).toContain(final.rows[0]?.role_summary);
    expect(final.rows[0]?.role_brief).toBe(final.rows[0]?.role_summary);
  });
});
