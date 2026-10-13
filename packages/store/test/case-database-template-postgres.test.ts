import { afterAll, describe, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  closeTestDatabase, startTestCaseDatabase, startTestDatabase, startTestDatabaseThrough,
  type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

/*
 * A case database cloned from the per-server template must be the database a from-scratch
 * migration would have produced. CREATE DATABASE ... TEMPLATE copies the contents but not the
 * database's own ACL (052 grants CONNECT and 066 revokes TEMPORARY on current_database()), so the
 * comparison covers that ACL as well as the schema, grants, ledgers, sequences and row counts.
 */

const ANTES_DE_LOS_ROLES = '051_companies.sql';

let actual: TestDatabase | undefined;
let anterior: TestDatabase | undefined;
const abiertas: EmptyTestDatabase[] = [];

preparePostgresSuite(import.meta.url, async () => {
  [actual, anterior] = await Promise.all([startTestDatabase(), startTestDatabaseThrough(ANTES_DE_LOS_ROLES)]);
}, 240_000);

afterAll(async () => {
  await Promise.all(abiertas.splice(0).map((base) => base.close()));
  await closeTestDatabase(actual);
  await closeTestDatabase(anterior);
});

async function filas(pool: DatabasePool, sql: string): Promise<unknown[]> {
  return (await pool.query<Record<string, unknown>>(sql)).rows;
}

async function recuentos(pool: DatabasePool): Promise<Record<string, number>> {
  const tablas = await pool.query<{ esquema: string; tabla: string }>(
    `SELECT n.nspname AS esquema, c.relname AS tabla FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','cauce_semilla') ORDER BY 1,2`,
  );
  const cuenta: Record<string, number> = {};
  for (const { esquema, tabla } of tablas.rows) {
    const total = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${esquema}.${tabla}`,
    );
    cuenta[`${esquema}.${tabla}`] = total.rows[0]?.n ?? -1;
  }
  return cuenta;
}

async function huella(pool: DatabasePool): Promise<Record<string, unknown>> {
  return {
    base: await filas(pool, `SELECT ARRAY(SELECT unnest(COALESCE(d.datacl, acldefault('d', d.datdba)))::text ORDER BY 1) AS acl,
        (SELECT count(*)::int FROM pg_db_role_setting s WHERE s.setdatabase=d.oid) AS ajustes,
        d.datconnlimit AS limite, d.datallowconn AS conecta
      FROM pg_database d WHERE d.datname=current_database()`),
    esquemas: await filas(pool, `SELECT nspname, nspacl::text AS acl FROM pg_namespace
      WHERE nspname !~ '^pg_(toast_)?temp_' ORDER BY 1`),
    extensiones: await filas(pool, `SELECT extname, extversion FROM pg_extension ORDER BY 1`),
    columnas: await filas(pool, `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema IN ('public','cauce_semilla') ORDER BY 1,2,3`),
    relaciones: await filas(pool, `SELECT n.nspname, c.relname, c.relkind, c.relacl::text AS acl, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','cauce_semilla') ORDER BY 1,2`),
    restricciones: await filas(pool, `SELECT conrelid::regclass::text AS tabla, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`),
    indices: await filas(pool, `SELECT schemaname, indexname, indexdef FROM pg_indexes
      WHERE schemaname IN ('public','cauce_semilla') ORDER BY 1,2`),
    funciones: await filas(pool, `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
        md5(pg_get_functiondef(p.oid)) AS def, p.proacl::text AS acl
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p') ORDER BY 1,2`),
    disparadores: await filas(pool, `SELECT tgrelid::regclass::text AS tabla, tgname, pg_get_triggerdef(oid) AS def
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`),
    politicas: await filas(pool, `SELECT schemaname, tablename, policyname, roles::text, cmd, qual, with_check
      FROM pg_policies ORDER BY 1,2,3`),
    secuencias: await filas(pool, `SELECT schemaname, sequencename, last_value FROM pg_sequences
      WHERE schemaname='public' ORDER BY 1,2`),
    migraciones: await filas(pool, `SELECT version FROM schema_migrations ORDER BY 1`),
    libro: await filas(pool, `SELECT version, source_sha256, source_origin FROM schema_migration_ledger ORDER BY 1`),
    filas: await recuentos(pool),
  };
}

async function abrir(servidor: TestDatabase, plantilla: boolean): Promise<EmptyTestDatabase> {
  const base = await startTestCaseDatabase(servidor, { plantilla });
  abiertas.push(base);
  return base;
}

describe('per-case database cloned from the server template', () => {
  it('is the database a from-scratch migration produces, database ACL included', async () => {
    if (actual === undefined) throw new Error('server not started');
    const desdeCero = await abrir(actual, false);
    const clonada = await abrir(actual, true);
    const otraClonada = await abrir(actual, true);

    const esperada = await huella(desdeCero.adminPool);
    expect(await huella(clonada.adminPool)).toEqual(esperada);
    expect(await huella(otraClonada.adminPool)).toEqual(esperada);
    expect(clonada.url).not.toBe(otraClonada.url);
    expect((await clonada.adminPool.query(`SELECT
        has_database_privilege('cauce_runtime', current_database(), 'TEMPORARY') AS temporal,
        has_database_privilege('cauce_runtime', current_database(), 'CONNECT') AS conecta`)).rows)
      .toEqual([{ temporal: false, conecta: true }]);
  });

  it('keeps the default database ACL when the migration cutoff never touched it', async () => {
    if (anterior === undefined) throw new Error('server not started');
    const desdeCero = await abrir(anterior, false);
    const clonada = await abrir(anterior, true);

    expect(await huella(clonada.adminPool)).toEqual(await huella(desdeCero.adminPool));
    expect((await clonada.adminPool.query(`SELECT datacl IS NULL AS nula FROM pg_database WHERE datname=current_database()`)).rows)
      .toEqual([{ nula: true }]);
  });

  it('does not leak writes from one case into the next clone', async () => {
    if (actual === undefined) throw new Error('server not started');
    const primera = await abrir(actual, true);
    await primera.adminPool.query('CREATE TABLE zz_caso_plantilla(marca int)');
    await primera.adminPool.query('INSERT INTO zz_caso_plantilla VALUES (1)');
    const segunda = await abrir(actual, true);

    expect((await segunda.adminPool.query(`SELECT to_regclass('public.zz_caso_plantilla') IS NULL AS ausente`)).rows)
      .toEqual([{ ausente: true }]);
  });

  // 048, 050 and 051 grant to cauce_gateway only if it exists: the template has to follow the cluster.
  it('migrates the template again when a test changes the cluster roles', async () => {
    if (actual === undefined) throw new Error('server not started');
    await abrir(actual, true);
    await actual.adminPool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN CREATE ROLE cauce_gateway; END IF;
    END $$`);
    const desdeCero = await abrir(actual, false);
    const clonada = await abrir(actual, true);

    expect((await desdeCero.adminPool.query(`SELECT count(*)::int > 0 AS concedido
      FROM information_schema.role_table_grants WHERE grantee='cauce_gateway'`)).rows).toEqual([{ concedido: true }]);
    expect(await huella(clonada.adminPool)).toEqual(await huella(desdeCero.adminPool));
  });
});
