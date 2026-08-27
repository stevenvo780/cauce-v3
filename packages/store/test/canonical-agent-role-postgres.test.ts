import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishMessage } from '@cauce/protocol';
import {
  AgentProfileRepository, CauceRepository, applyMigrations,
  type DatabasePool,
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

/**
 * Contrato 028 contra Postgres real.
 *
 * No alcanza con probar el helper que recorta: esta suite cruza las tres superficies que antes
 * divergían —perfil, columna legacy/plantillas y sobre de delivery— y además ejecuta down/up.
 */

let database: TestDatabase;
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
  if (!(await migrationApplied())) await applyMigrations(pool);
}

async function ensureDown(): Promise<void> {
  if (await migrationApplied()) await runSql(downPath);
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

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

beforeEach(async () => {
  await ensureUp();
  await resetTestDatabase(pool);
  await pool.query('TRUNCATE config_revisions RESTART IDENTITY CASCADE');
  await pool.query(`DELETE FROM agent_role_templates WHERE slug LIKE 'test_%'`);
});

afterAll(async () => {
  try {
    if (pool) await ensureUp();
  } finally {
    if (pool) await pool.end();
    if (database?.container) await database.container.stop();
  }
});

describe('reconciliación y compatibilidad de la migración 028', () => {
  it('el down espera el mismo advisory lock del migrador antes de tocar triggers o datos', async () => {
    const source = await readFile(downPath, 'utf8');
    const holder = await pool.connect();
    const runner = await pool.connect();
    let down: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      const runnerPid = await runner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      down = runner.query(source);

      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const observed = await pool.query<{ waiting: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted
           ) AS waiting`,
          [runnerPid.rows[0]!.pid],
        );
        if (observed.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      expect(await migrationApplied()).toBe(true);

      await holder.query('COMMIT');
      await down;
      down = undefined;
      expect(await migrationApplied()).toBe(false);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      if (down !== undefined) await down.catch(() => undefined);
      holder.release();
      runner.release();
    }
  });

  it('hace ganar el perfil existente y sólo si falta perfil siembra el legacy', async () => {
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

    await applyMigrations(pool);

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

  it('el down conserva el perfil rico y deja una proyección usable por una imagen anterior', async () => {
    await insertAgent('Steven', 'rollback_safe');
    const rich = `${'a'.repeat(1_199)}🎉${'detalle'.repeat(30)}`;
    await pool.query(
      `INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES ('Steven','rollback_safe',$1)`,
      [rich],
    );

    await ensureDown();

    const state = await pool.query<{ role_summary: string; role_brief: string }>(
      `SELECT profile.role_summary,agent.role_brief
         FROM agents agent JOIN agent_profiles profile USING (tenant_id,alias)
        WHERE agent.tenant_id='Steven' AND agent.alias='rollback_safe'`,
    );
    expect(state.rows[0]?.role_summary).toBe(rich);
    expect([...state.rows[0]!.role_brief]).toHaveLength(1_200);
    expect(state.rows[0]?.role_brief.endsWith('🎉')).toBe(true);

    await applyMigrations(pool);
    expect((await new AgentProfileRepository(pool).read('Steven', 'rollback_safe')).role_summary)
      .toBe(rich);
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

describe('delivery context real', () => {
  it('deriva self_role del mismo perfil rico que se entrega en hello, sin confiar en la caché', async () => {
    await insertAgent('Steven', 'argos', null, true);
    const rich = `${'r'.repeat(1_199)}🎉${'detalle'.repeat(20)}`;
    const profiles = new AgentProfileRepository(pool);
    await profiles.replace(
      { tenant_id: 'Steven', alias: 'argos', role_summary: rich }, null, ACTOR,
    );

    // Daño deliberado de la proyección, con los triggers apagados sólo durante esta sentencia. El
    // claim correcto tiene que seguir saliendo del perfil y no de esta caché.
    await pool.query('ALTER TABLE agents DISABLE TRIGGER agents_translate_legacy_role');
    try {
      await pool.query(
        `UPDATE agents SET role_brief='caché dañada'
          WHERE tenant_id='Steven' AND alias='argos'`,
      );
    } finally {
      await pool.query('ALTER TABLE agents ENABLE TRIGGER agents_translate_legacy_role');
    }

    const repository = new CauceRepository(pool);
    const instance = `identity-${randomUUID()}`;
    const lease = await repository.acquireLease(
      'Steven', 'argos', instance, ['agent_identity_v1', 'agent_profile_v1'], 30_000,
    );
    const message: PublishMessage = {
      version: '3.0', request_id: randomUUID(), trace_id: `trace-${randomUUID()}`,
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'comprueba tu identidad' }, idempotency_key: randomUUID(),
      lane: 'interactive', priority: 0,
    };
    await repository.publish(message);
    const [delivery] = await repository.claimDeliveries(
      'Steven', 'argos', instance, lease.epoch!, 1, 30_000,
    );

    expect(delivery).toBeDefined();
    expect([...(delivery?.self_role ?? '')]).toHaveLength(1_200);
    expect(delivery?.self_role?.endsWith('🎉')).toBe(true);
    expect(delivery?.self_role).not.toBe('caché dañada');
    expect((await profiles.readContext('Steven', 'argos')).perfil.role_summary).toBe(rich);
  });
});
