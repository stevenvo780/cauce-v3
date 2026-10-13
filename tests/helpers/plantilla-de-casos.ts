import type { DatabasePool } from '@cauce/store';

/**
 * The per-server template every case database is cloned from. A clone does not inherit the ACL of
 * the database itself (052 grants CONNECT, 066 revokes TEMPORARY on current_database()), and a
 * migration also reads the cluster's roles (048, 050 and 051 grant to cauce_gateway if it exists):
 * the template carries both, so a clone is the database migrating now would produce.
 */
export interface PlantillaDeCasos {
  nombre: string;
  roles: string;
  acl: string[];
  aclPorDefecto: boolean;
  permisos: string[];
}

export interface ConPlantillaDeCasos {
  plantillaDeCasos?: Promise<PlantillaDeCasos>;
}

const HUELLA_DE_ROLES = `SELECT md5(COALESCE(string_agg(fila, E'\\n' ORDER BY fila), '')) AS huella FROM (
    SELECT to_jsonb(r)::text AS fila FROM pg_roles r UNION ALL SELECT to_jsonb(m)::text FROM pg_auth_members m) roles`;
const ACL_DE_BASE = `SELECT COALESCE(d.datacl, acldefault('d', d.datdba))::text[] AS acl,
    d.datacl IS NULL AS por_defecto, quote_ident(pg_get_userbyid(d.datdba)) AS dueno,
    (SELECT count(*)::int FROM pg_db_role_setting s WHERE s.setdatabase=d.oid) AS ajustes
  FROM pg_database d WHERE d.datname=$1`;
const PERMISOS_DE_BASE = `SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS rol,
    a.privilege_type AS privilegio, a.is_grantable AS cedible
  FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) WITH ORDINALITY a WHERE d.datname=$1
  ORDER BY a.ordinality`;
const PRIVILEGIO_DE_BASE = /^(?:CREATE|CONNECT|TEMPORARY)$/u;

function codigo(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
}

export async function huellaDeRoles(admin: DatabasePool): Promise<string> {
  return (await admin.query<{ huella: string }>(HUELLA_DE_ROLES)).rows[0]?.huella ?? '';
}

async function aclDeBase(admin: DatabasePool, base: string): Promise<{
  acl: string[]; porDefecto: boolean; dueno: string; ajustes: number;
}> {
  const fila = (await admin.query<{ acl: string[]; por_defecto: boolean; dueno: string; ajustes: number }>(
    ACL_DE_BASE, [base],
  )).rows[0];
  if (fila === undefined) throw new Error(`la base ${base} no existe`);
  return { acl: fila.acl, porDefecto: fila.por_defecto, dueno: fila.dueno, ajustes: fila.ajustes };
}

export async function leerPlantillaDeCasos(
  admin: DatabasePool, nombre: string, roles: string,
): Promise<PlantillaDeCasos> {
  const { acl, porDefecto, dueno, ajustes } = await aclDeBase(admin, nombre);
  if (ajustes > 0) {
    throw new Error(`la plantilla de casos ${nombre} tiene ${String(ajustes)} ajuste(s) ALTER DATABASE ... SET ` +
      'que CREATE DATABASE TEMPLATE no copia: sus clones dejarían de ser la base que migrar produce');
  }
  if (porDefecto) return { nombre, roles, acl, aclPorDefecto: true, permisos: [] };
  const concesiones = await admin.query<{ rol: string; privilegio: string; cedible: boolean }>(
    PERMISOS_DE_BASE, [nombre],
  );
  const permisos = [`REVOKE ALL ON DATABASE %I FROM PUBLIC, ${dueno}`];
  for (const { rol, privilegio, cedible } of concesiones.rows) {
    if (!PRIVILEGIO_DE_BASE.test(privilegio)) throw new Error(`privilegio de base inesperado: ${privilegio}`);
    permisos.push(`GRANT ${privilegio} ON DATABASE %I TO ${rol}${cedible ? ' WITH GRANT OPTION' : ''}`);
  }
  return { nombre, roles, acl, aclPorDefecto: false, permisos };
}

/** Clones the template and rebuilds its database ACL, in the template's order, then checks it. */
export async function clonarCaso(admin: DatabasePool, nombre: string, plantilla: PlantillaDeCasos): Promise<void> {
  for (let intento = 1; ; intento += 1) {
    try {
      await admin.query(`CREATE DATABASE ${nombre} TEMPLATE ${plantilla.nombre}`);
      break;
    } catch (error) { // 55006: the builder's connection to the template was still closing
      if (codigo(error) !== '55006' || intento === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, intento * 100));
    }
  }
  if (plantilla.aclPorDefecto) return;
  await admin.query(plantilla.permisos.map((sentencia) => sentencia.replace('%I', nombre)).join(';\n'));
  const { acl } = await aclDeBase(admin, nombre);
  if (acl.join(',') !== plantilla.acl.join(',')) {
    throw new Error(`el clon ${nombre} no quedó con el ACL de base de ${plantilla.nombre}: ` +
      `${acl.join(',')} frente a ${plantilla.acl.join(',')}`);
  }
}

/** Migrates a template until the roles it read are the roles it leaves (052 creates its own). */
async function migrarPlantilla(admin: DatabasePool, migrarUna: () => Promise<string>): Promise<PlantillaDeCasos> {
  for (let intento = 1; ; intento += 1) {
    const roles = await huellaDeRoles(admin);
    const nombre = await migrarUna();
    if (await huellaDeRoles(admin) === roles) return leerPlantillaDeCasos(admin, nombre, roles);
    if (intento === 3) throw new Error('los roles del servidor cambiaron en cada migración de la plantilla de casos');
  }
}

/**
 * The server's template, built on first use by `migrarUna` (it returns the migrated database's
 * name) and migrated again when a test created, dropped or altered a role since.
 */
export async function plantillaVigente(
  servidor: ConPlantillaDeCasos, abrirAdmin: () => DatabasePool, migrarUna: () => Promise<string>,
): Promise<PlantillaDeCasos> {
  const admin = abrirAdmin();
  try {
    for (let intento = 1; ; intento += 1) {
      let memo = servidor.plantillaDeCasos;
      if (memo === undefined) {
        const nueva = migrarPlantilla(admin, migrarUna);
        memo = nueva;
        servidor.plantillaDeCasos = nueva;
        nueva.catch(() => {
          if (servidor.plantillaDeCasos === nueva) delete servidor.plantillaDeCasos;
        });
      }
      const plantilla = await memo;
      if (await huellaDeRoles(admin) === plantilla.roles) return plantilla;
      if (servidor.plantillaDeCasos === memo) delete servidor.plantillaDeCasos;
      if (intento === 3) throw new Error('los roles del servidor no dejan de cambiar entre plantilla y caso');
    }
  } finally {
    await admin.end();
  }
}
