import { preparePostgresSuite } from './postgres-suite.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Catalog table isolation in tests.
 *
 * Verifies that `resetTestDatabase()` restores catalog tables to their seed state
 * to prevent state leaks between test suites.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 180_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

describe('el catálogo vuelve a como lo dejaron las migraciones', () => {
  it('una suite que apaga los permisos de operator no se los deja apagados a la siguiente', async () => {
    const antes = await pool.query<{ allow_route: boolean; allow_control: boolean }>(
      `SELECT allow_route, allow_control FROM role_policies WHERE role = 'operator'`,
    );
    expect(antes.rows[0]?.allow_route).toBe(true);
    expect(antes.rows[0]?.allow_control).toBe(true);

    // This is exactly what more than one suite in the repo does.
    await pool.query(`UPDATE role_policies SET allow_route=false, allow_control=false WHERE role='operator'`);

    await resetTestDatabase(pool);

    const despues = await pool.query<{ allow_route: boolean; allow_control: boolean }>(
      `SELECT allow_route, allow_control FROM role_policies WHERE role = 'operator'`,
    );
    expect(despues.rows[0]?.allow_route).toBe(true);
    expect(despues.rows[0]?.allow_control).toBe(true);
  }, 120_000);

  it('un rol inventado por una suite NO sobrevive al reset', async () => {
    /*
     * `agent_notify` is the real case: no migration creates it, so its presence can only
     * come from another suite. A test that depends on it passes or fails depending on who ran before.
     */
    await pool.query(
      `INSERT INTO role_policies(role, allow_route, allow_read, allow_control)
       VALUES ('rol_inventado_por_otra_suite', true, true, true)
       ON CONFLICT (role) DO NOTHING`,
    );
    await resetTestDatabase(pool);
    const hay = await pool.query(`SELECT 1 FROM role_policies WHERE role='rol_inventado_por_otra_suite'`);
    expect(hay.rowCount).toBe(0);
  }, 120_000);

  it('una membresía añadida por una suite NO sobrevive al reset', async () => {
    const antes = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM memberships`);
    await pool.query(
      `INSERT INTO memberships(tenant_id, room_id, alias, role)
       SELECT tenant_id, room_id, 'alias_de_otra_suite', role FROM memberships LIMIT 1
       ON CONFLICT DO NOTHING`,
    );
    await resetTestDatabase(pool);
    const despues = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM memberships`);
    expect(despues.rows[0]?.n).toBe(antes.rows[0]?.n);
  }, 120_000);

  // ── NEGATIVE CONTROL ──────────────────────────────────────────────────────────────────────

  it('CONTROL NEGATIVO: el reset NO borra el escenario, sólo lo devuelve a su sitio', async () => {
    /*
     * Without this, "restore" could be implemented by emptying the tables and the test above
     * would stay green: zero rows is also "did not survive". Here we require that the scenario
     * KEEPS existing, which is what every suite needs to run.
     */
    const t = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM tenants`);
    const m = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM memberships`);
    const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM role_policies`);
    expect(Number(t.rows[0]?.n)).toBeGreaterThan(0);
    expect(Number(m.rows[0]?.n)).toBeGreaterThan(0);
    expect(Number(r.rows[0]?.n)).toBeGreaterThan(0);
  }, 120_000);

  it('CONTROL NEGATIVO: dos resets seguidos dan exactamente el mismo catálogo', async () => {
    const huella = async () => {
      const q = await pool.query<{ h: string }>(
        `SELECT md5(string_agg(t, '|' ORDER BY t)) AS h FROM (
           SELECT role || allow_route::text || allow_read::text || allow_control::text AS t FROM role_policies
           UNION ALL SELECT tenant_id || room_id || alias || role FROM memberships
           UNION ALL SELECT id FROM tenants
         ) s`,
      );
      return q.rows[0]?.h;
    };
    const primera = await huella();
    await resetTestDatabase(pool);
    const segunda = await huella();
    expect(segunda).toBe(primera);
    expect(primera).toMatch(/^[0-9a-f]{32}$/);
  }, 120_000);
});
