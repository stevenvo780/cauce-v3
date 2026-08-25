import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/*
 * LA FUGA QUE HACÍA IRREPRODUCIBLES TODAS LAS MEDICIONES DE ESTE REPO.
 *
 * `resetTestDatabase()` nunca truncó las tablas de catálogo —`role_policies`, `tenants`, `rooms`,
 * `memberships`, `acl_edges`— y hacía bien: vaciarlas dejaría a cada suite sin escenario. Pero
 * tampoco las RESTAURABA, así que valían lo que hubiera dejado la última suite que corrió.
 *
 * Dos hechos medidos el 2026-08-24 que lo demuestran:
 *   · la migración 003 siembra `operator(route,read,control)`, y en una base compartida llegaba
 *     con los tres en falso porque otra suite los había apagado;
 *   · el rol `agent_notify` **no lo crea ninguna migración** —sólo lo nombran los comentarios de
 *     la 009— y sin embargo existía, porque otra suite lo había insertado.
 *
 * La consecuencia no es un detalle de higiene: el MISMO código daba 6, 18 o 19 fallos según el
 * orden de las suites. Y en este repo todo el criterio de «esto ya fallaba antes» se apoya en
 * comparar contra una línea base. Con el catálogo filtrándose, esa comparación no significa nada
 * — ni la mía, ni la de nadie.
 */

let database: TestDatabase;
let pool: DatabasePool;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

afterAll(async () => {
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

    // Esto es exactamente lo que hace más de una suite del repo.
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
     * `agent_notify` es el caso real: ninguna migración lo crea, así que su presencia sólo puede
     * venir de otra suite. Una prueba que dependa de él pasa o falla según quién corrió antes.
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

  // ── CONTROL NEGATIVO ──────────────────────────────────────────────────────────────────────

  it('CONTROL NEGATIVO: el reset NO borra el escenario, sólo lo devuelve a su sitio', async () => {
    /*
     * Sin esto, «restaurar» podría implementarse vaciando las tablas y la prueba de arriba
     * seguiría verde: cero filas también es «no sobrevivió». Aquí se exige que el escenario
     * SIGA existiendo, que es lo que toda suite necesita para poder correr.
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
    expect(primera).toBeTruthy();
  }, 120_000);
});
