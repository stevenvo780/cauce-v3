import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import { startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * LA MIGRACIÓN 026, APLICADA DE VERDAD: arriba, abajo y arriba otra vez.
 *
 * Una migración leída no es una migración probada. Ésta se aplica contra un Postgres real, se
 * REVIERTE con su `down/`, y se vuelve a aplicar — que es lo único que demuestra que el `down/`
 * es reversa de algo y no un fichero que nadie corrió nunca.
 *
 * Además prueba la SIEMBRA, que no se puede ver de otra forma: `applyMigrations` corre las 23
 * migraciones de una sentada sobre una base vacía, así que cuando 026 se aplica por primera vez no
 * hay ningún `agents.role_brief` que copiar. El único modo de ver la siembra funcionando es bajar
 * 026, poner briefs, y volver a subirla. Eso es exactamente lo que pasará en producción, donde la
 * tabla `agents` lleva quince filas con su rol escrito.
 *
 * NO USA `resetTestDatabase`: este fichero manipula el ESQUEMA, no las filas.
 */

let database: TestDatabase;
let pool: DatabasePool;

const upPath = new URL('../migrations/026_agent_profile.sql', import.meta.url);
const downPath = new URL('../migrations/down/026_agent_profile.sql', import.meta.url);
const canonicalDownPath = new URL('../migrations/down/028_canonical_agent_role.sql', import.meta.url);
const profileRuntimeDownPath = new URL(
  '../migrations/down/035_agent_profile_runtime_adoption.sql', import.meta.url,
);
const shadowPhaseDownPath = new URL(
  '../migrations/down/036_shadow_router_target_phase.sql', import.meta.url,
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
  // 035 owns tables with FKs to agent_profiles. Its down in turn refuses to run while 036 is
  // present, so exercise the real dependency order instead of using CASCADE or deleting ledger
  // rows. Migrations 029-034 do not reference agent_profiles and remain deliberately untouched.
  const dependents = [
    ['036_shadow_router_target_phase.sql', shadowPhaseDownPath],
    ['035_agent_profile_runtime_adoption.sql', profileRuntimeDownPath],
    ['028_canonical_agent_role.sql', canonicalDownPath],
  ] as const;
  for (const [version, path] of dependents) {
    if (await migrationApplied(version)) await runSql(path);
  }
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  // Dejar el esquema ARRIBA pase lo que pase: los otros ficheros de la suite comparten esta base
  // y encontrarla a medio migrar les rompería por un motivo que no es el suyo.
  try {
    if (pool) await applyMigrations(pool);
  } finally {
    if (pool) await pool.end();
    if (database?.container) await database.container.stop();
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
    // Un alias SIN role_brief no puede acabar con una fila de perfil vacía.
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
   * CONTROL NEGATIVO del ORDEN del `down/`, y la razón MEDIDA de que ese orden sea el correcto.
   *
   * La primera versión de este test daba por supuesto —y el comentario del `down/` lo afirmaba—
   * que Postgres NO registra la dependencia entre un CHECK y la función que invoca, y que por eso
   * bajar la función antes que la tabla la dejaría viva y envenenada. ES FALSO, y lo dijo esta
   * prueba la primera vez que se corrió: PostgreSQL 16 SÍ registra esa dependencia en `pg_depend`
   * y RECHAZA el `DROP FUNCTION` con `2BP01` (dependent_objects_still_exist), incluso con
   * `IF EXISTS`, que sólo perdona que la función no exista y no que tenga dependientes.
   *
   * O sea que el orden del `down/` no lo sostiene la disciplina de quien lo escribió: lo sostiene
   * la base, que se niega. Lo que este test protege es que siga siendo así — si una versión futura
   * dejara de registrar la dependencia, el `DROP` pasaría, este test se pondría rojo, y el orden
   * del `down/` volvería a depender de que alguien se acuerde.
   */
  it('control negativo: la base RECHAZA soltar la función mientras la tabla la use', async () => {
    expect(await tableExists('agent_profiles')).toBe(true);
    // El orden EQUIVOCADO, el que el down/ evita. La base no lo permite.
    await expect(pool.query('DROP FUNCTION IF EXISTS cauce_utf16_units(text)'))
      .rejects.toMatchObject({ code: '2BP01' });
    await expect(pool.query('DROP FUNCTION IF EXISTS cauce_text_items_ok(text[], integer)'))
      .rejects.toMatchObject({ code: '2BP01' });
    expect(await functionExists('cauce_utf16_units')).toBe(true);
    expect(await functionExists('cauce_text_items_ok')).toBe(true);

    // Y el orden CORRECTO —el del down/— sí funciona, entero y en una sola pasada.
    await downProfileDependentsIfApplied();
    await runSql(downPath);
    expect(await tableExists('agent_profiles')).toBe(false);
    expect(await functionExists('cauce_utf16_units')).toBe(false);

    await applyMigrations(pool);
    expect(await tableExists('agent_profiles')).toBe(true);
    expect(await functionExists('cauce_utf16_units')).toBe(true);
  });
});
