import { preparePostgresSuite } from './postgres-suite.js';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import { startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { removeSecretHandoffLayer } from './secret-handoff-layer.js';
import { removeTerminalControlHoldsLayer } from './terminal-control-holds-layer.js';

/**
 * MIGRATION 026, REALLY APPLIED: up, down and up again.
 *
 * A migration that has been read has not been tested. This one is applied against a real
 * Postgres, REVERTED with its `down/`, and applied again — which is the only thing that proves
 * the `down/` is the reverse of something and not a file nobody ever ran.
 *
 * It also tests the SEED, which cannot be observed any other way: `applyMigrations` runs all 23
 * migrations in one shot against an empty database, so when 026 is applied for the first time
 * there is no `agents.role_brief` to copy. The only way to see the seeding work is to revert
 * 026, set briefs, and re-apply it. That is exactly what will happen in production, where the
 * `agents` table carries fifteen rows with their role written.
 *
 * DOES NOT USE `resetTestDatabase`: this file manipulates the SCHEMA, not the rows.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;

const upPath = new URL('../migrations/026_agent_profile.sql', import.meta.url);
const downPath = new URL('../migrations/down/026_agent_profile.sql', import.meta.url);
const canonicalDownPath = new URL('../migrations/down/028_canonical_agent_role.sql', import.meta.url);
const profileRuntimeDownPath = new URL(
  '../migrations/down/035_agent_profile_runtime_adoption.sql', import.meta.url,
);
const consolePublishIndexesDownPath = new URL(
  '../migrations/down/037_console_publish_intent_indexes.sql', import.meta.url,
);
const textItemsSearchPathDownPath = new URL(
  '../migrations/down/038_cauce_text_items_ok_search_path.sql', import.meta.url,
);

async function runSql(url: URL): Promise<void> {
  await pool.query(await readFile(url, 'utf8'));
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists', [name]
  );
  return result.rows[0]?.exists === true;
}

async function functionExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname=$1) AS exists', [name]
  );
  return result.rows[0]?.exists === true;
}

async function migrationApplied(version: string): Promise<boolean> {
  const applied = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1) AS exists`, [version],
  );
  return applied.rows[0]?.exists === true;
}

async function downProfileDependentsIfApplied(): Promise<void> {
  await removeTerminalControlHoldsLayer(pool);
  await removeSecretHandoffLayer(pool);
  // 035 owns tables with FKs to agent_profiles, so exercise the real dependency order.
  const dependents = [
    ['038_cauce_text_items_ok_search_path.sql', textItemsSearchPathDownPath],
    ['037_console_publish_intent_indexes.sql', consolePublishIndexesDownPath],
    ['035_agent_profile_runtime_adoption.sql', profileRuntimeDownPath],
    ['028_canonical_agent_role.sql', canonicalDownPath],
  ] as const;
  for (const [version, path] of dependents) {
    if (await migrationApplied(version)) {
      await runSql(path);
      await pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
    }
  }
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
    // Leave the schema UP no matter what: the other files in the suite share this database,
    // and finding it half-migrated would break them for a reason that is not theirs.
  try {
    await applyMigrations(pool);
  } finally {
    await pool.end();
    await database.container.stop();
  }
});

describe('026 arriba, abajo y arriba otra vez', () => {
  it('applyMigrations la deja aplicada, con su tabla y sus dos funciones', async () => {
    await applyMigrations(pool);
    expect(await tableExists('agent_profiles')).toBe(true);
    expect(await functionExists('cauce_utf16_units')).toBe(true);
    expect(await functionExists('cauce_text_items_ok')).toBe(true);
  });

  it('el down/ la revierte entera: se va la tabla, se van las funciones y se va la anotación', async () => {
    await downProfileDependentsIfApplied();
    await runSql(downPath);
    expect(await tableExists('agent_profiles')).toBe(false);
    expect(await functionExists('cauce_utf16_units')).toBe(false);
    expect(await functionExists('cauce_text_items_ok')).toBe(false);
    const applied = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version='026_agent_profile.sql') AS exists`
    );
    expect(applied.rows[0]?.exists).toBe(false);
  });

  it('revertirla NO toca agents.role_brief: el alias conserva su identidad', async () => {
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,role_brief)
       VALUES ('Steven','zeus','claude','zeus',false,'Médico de la flota.')
       ON CONFLICT (tenant_id,alias) DO UPDATE SET role_brief=EXCLUDED.role_brief`
    );
    const brief = await pool.query<{ role_brief: string }>(
      `SELECT role_brief FROM agents WHERE tenant_id='Steven' AND alias='zeus'`
    );
    expect(brief.rows[0]?.role_brief).toBe('Médico de la flota.');
  });

  it('volver a aplicarla SIEMBRA el role_brief de cada alias en role_summary, literal', async () => {
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,role_brief)
       VALUES ('Steven','argos','claude','argos',false,'  PMO: perseguir lo pendiente.  ')
       ON CONFLICT (tenant_id,alias) DO UPDATE SET role_brief=EXCLUDED.role_brief`
    );
    // An alias WITHOUT role_brief must not end up with an empty profile row.
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,role_brief)
       VALUES ('Steven','mudo','claude','mudo',false,NULL)
       ON CONFLICT (tenant_id,alias) DO UPDATE SET role_brief=NULL`
    );

    await applyMigrations(pool);

    const sembrados = await pool.query<{ alias: string; role_summary: string }>(
      `SELECT alias,role_summary FROM agent_profiles ORDER BY alias`
    );
    expect(sembrados.rows).toEqual([
      { alias: 'argos', role_summary: 'PMO: perseguir lo pendiente.' },
      { alias: 'zeus', role_summary: 'Médico de la flota.' }
    ]);
    expect(sembrados.rows.some((row) => row.alias === 'mudo')).toBe(false);
  });

  it('la siembra deja created_at = updated_at, que es lo que dice «esto todavía es la copia»', async () => {
    const marcas = await pool.query<{ igual: boolean }>(
      `SELECT bool_and(created_at = updated_at) AS igual FROM agent_profiles`
    );
    expect(marcas.rows[0]?.igual).toBe(true);
  });

  it('re-aplicarla es idempotente: no pisa un perfil ya escrito', async () => {
    await pool.query(
      `UPDATE agent_profiles SET role_summary='Editado a mano.', updated_at=now() WHERE alias='zeus'`
    );
    await runSql(upPath);
    const tras = await pool.query<{ role_summary: string }>(
      `SELECT role_summary FROM agent_profiles WHERE alias='zeus'`
    );
    expect(tras.rows[0]?.role_summary).toBe('Editado a mano.');
  });

  /**
   * NEGATIVE CONTROL on the ORDER of the `down/`, and the MEASURED reason that order is right.
   *
   * The first version of this test assumed —and the `down/` comment asserted— that Postgres does
   * NOT record the dependency between a CHECK and the function it invokes, and that is why
   * dropping the function before the table would leave it alive and poisoned. THAT IS FALSE, and
   * this test proved it the first time it ran: PostgreSQL 16 DOES record that dependency in
   * `pg_depend` and REJECTS the `DROP FUNCTION` with `2BP01` (dependent_objects_still_exist),
   * even with `IF EXISTS`, which only forgives the function not existing, not having dependents.
   *
   * So the `down/` order is not upheld by the discipline of its author: the database upholds it
   * by refusing. What this test guards is that it stays that way — if a future version stopped
   * recording the dependency, the `DROP` would pass, this test would turn red, and the `down/`
   * order would depend again on someone remembering.
   */
  it('control negativo: la base RECHAZA soltar la función mientras la tabla la use', async () => {
    expect(await tableExists('agent_profiles')).toBe(true);
    // The WRONG order, the one the down/ avoids. The database does not allow it.
    await expect(pool.query('DROP FUNCTION IF EXISTS cauce_utf16_units(text)'))
      .rejects.toMatchObject({ code: '2BP01' });
    await expect(pool.query('DROP FUNCTION IF EXISTS cauce_text_items_ok(text[], integer)'))
      .rejects.toMatchObject({ code: '2BP01' });
    expect(await functionExists('cauce_utf16_units')).toBe(true);
    expect(await functionExists('cauce_text_items_ok')).toBe(true);

    // And the CORRECT order —the down/'s one— does work, whole and in a single pass.
    await downProfileDependentsIfApplied();
    await runSql(downPath);
    expect(await tableExists('agent_profiles')).toBe(false);
    expect(await functionExists('cauce_utf16_units')).toBe(false);

    await applyMigrations(pool);
    expect(await tableExists('agent_profiles')).toBe(true);
    expect(await functionExists('cauce_utf16_units')).toBe(true);
  });
});
