import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, expect, type TestContext } from 'vitest';
import {
  applyMigrations, createPool, migrationSourcesForApply,
  type DatabaseClient, type DatabasePool
} from '@cauce/store';

export interface TestDatabase {
  container: StartedTestContainer;
  pool: DatabasePool;
  url: string;
}

export interface EmptyTestDatabase {
  close: () => Promise<void>;
  pool: DatabasePool;
  url: string;
}

export interface DockerTestRequirement {
  skipIfUnavailable: (skipTest: TestContext['skip']) => Promise<void>;
}

const execFileAsync = promisify(execFile);

async function waitForDatabase(pool: DatabasePool): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
      const msg = error instanceof Error ? error.message : '';
      if (!['ECONNREFUSED', 'ECONNRESET', '57P03', '08006'].includes(code)
          && !msg.includes('Connection terminated unexpectedly')) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, attempt * 50)));
    }
  }
  throw lastError;
}

/**
 * The database name prefix a `CAUCE_TEST_DATABASE_URL` MUST carry to be accepted.
 * This is what separates "run the suite" from "truncate production". The suites call
 * `resetTestDatabase()`, which TRUNCATEs 30 tables CASCADE. If the real database URL is exported
 * by mistake, the suite would silently wipe it; the check is therefore on the name and fails closed.
 */
const PREFIJO_BASE_DE_PRUEBAS = 'cauce_test';

/** Extracts the database name from a Postgres URL without bringing in dependencies. */
export function nombreDeBase(url: string): string {
  const ruta = new URL(url).pathname;
  return ruta.startsWith('/') ? ruta.slice(1) : ruta;
}

/**
 * Whether this URL points to a disposable test database.
 * Exported on purpose so the guard can be tested in isolation, using the production URL as the
 * negative control. A guard that is never tested against the case it is meant to prevent is not a guard.
 */
export function esBaseDePruebas(url: string): boolean {
  try {
    return nombreDeBase(url).startsWith(PREFIJO_BASE_DE_PRUEBAS);
  } catch {
    return false;
  }
}

function assertTestDatabaseUrl(url: string): void {
  if (esBaseDePruebas(url)) return;
  throw new Error(
    `CAUCE_TEST_DATABASE_URL apunta a la base "${nombreDeBase(url)}" y las pruebas ` +
      `TRUNCAN 30 tablas. Sólo se acepta una base cuyo nombre empiece por ` +
      `"${PREFIJO_BASE_DE_PRUEBAS}". Rechazado antes de abrir la conexión.`,
  );
}

function errorField(error: unknown, field: string): string {
  if (typeof error !== 'object' || error === null || !(field in error)) return '';
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function errorBooleanField(error: unknown, field: string): boolean {
  return typeof error === 'object'
    && error !== null
    && field in error
    && (error as Record<string, unknown>)[field] === true;
}

async function unavailableDockerCapability(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    return stdout.trim() === '' ? 'Docker server probe returned no version' : undefined;
  } catch (error) {
    if (errorField(error, 'code') === 'ENOENT') return 'Docker CLI unavailable';
    const stderr = errorField(error, 'stderr');
    if (stderr.includes('Cannot connect to the Docker daemon')) return 'Docker daemon unavailable';
    if (stderr.toLowerCase().includes('permission denied')) return 'Docker daemon inaccessible';
    if (errorField(error, 'code') === 'ETIMEDOUT'
        || errorBooleanField(error, 'killed')
        || errorField(error, 'signal') === 'SIGTERM') return 'Docker server probe timed out';
    return 'Docker server probe failed';
  }
}

export const SUITES_SIN_PLANTILLA: ReadonlySet<string> = new Set([
  'migration-integrity-postgres.test.ts',
  'secret-handoff-migration-postgres.test.ts',
  'agent-profile-migration-postgres.test.ts',
  'connection-session-fencing-migration-postgres.test.ts',
  'dlq-causal-reconciliation-migration-postgres.test.ts',
  'console-publish-intent-migration-postgres.test.ts',
  'agent-profile-runtime-adoption-migration-postgres.test.ts',
  'terminal-session-claim-fencing-migration-postgres.test.ts',
  'terminal-browser-owner-fencing-migration-postgres.test.ts',
  'terminal-relay-instance-fencing-migration-postgres.test.ts',
]);

const conteoPorFichero = new Map<string, { ejecutados: number; razon: string; saltados: number }>();
let suiteActual: string | undefined; // vitest isolates this module per test file, so it is the file

export function registrarSuite(fichero: string): void {
  suiteActual = fichero;
}

function conteo(fichero: string): { ejecutados: number; razon: string; saltados: number } {
  const actual = conteoPorFichero.get(fichero) ?? { ejecutados: 0, razon: '', saltados: 0 };
  conteoPorFichero.set(fichero, actual);
  return actual;
}

export function registrarSalto(fichero: string, razon: string): void {
  const actual = conteo(fichero);
  actual.saltados += 1;
  actual.razon = razon;
}

export function registrarEjecucion(fichero: string): void {
  conteo(fichero).ejecutados += 1;
}

export function resumenDeSaltos(): { fichero: string; razon: string; saltados: number }[] {
  return [...conteoPorFichero.entries()]
    .filter(([, actual]) => actual.ejecutados === 0 && actual.saltados > 0)
    .map(([fichero, actual]) => ({ fichero, razon: actual.razon, saltados: actual.saltados }));
}

export function ficheroDeLaSuite(): string | undefined {
  if (suiteActual !== undefined) return suiteActual;
  const ruta = expect.getState().testPath; // vitest lo fija por fichero, ya al recolectar
  return typeof ruta === 'string' ? ruta.split('/').at(-1) : undefined;
}

const veredictoAnunciado = new Set<string>();

function anunciarVeredicto(fichero: string): void { // una linea por FICHERO, no por test
  if (veredictoAnunciado.has(fichero)) return;
  veredictoAnunciado.add(fichero);
  afterEach((context) => { // a test that ran (not skipped) proves the file checked something
    if (context.task.result?.state !== 'skip') registrarEjecucion(fichero);
  });
  afterAll(() => {
    for (const salto of resumenDeSaltos()) {
      if (salto.fichero !== fichero) continue;
      console.warn(
        `[capacidad] ${fichero}: 0 ejecutados, ${String(salto.saltados)} saltados — ${salto.razon}`,
      );
    }
  });
}

export function dockerTestRequirement(
  unverifiedCoverage: string,
  probe: () => Promise<string | undefined> = unavailableDockerCapability,
): DockerTestRequirement {
  const declarado = ficheroDeLaSuite();
  if (declarado !== undefined) anunciarVeredicto(declarado);
  return {
    skipIfUnavailable: async (skipTest) => {
      const fichero = declarado ?? ficheroDeLaSuite();
      const unavailableCapability = process.env.CAUCE_REQUIRE_TESTCONTAINERS === '1'
        ? undefined
        : await probe();
      if (unavailableCapability === undefined) {
        if (fichero !== undefined) registrarEjecucion(fichero); // no saltó: el fichero sí comprobó
        return;
      }
      const reason = `${unavailableCapability}; not checked: ${unverifiedCoverage}`;
      console.warn(`[docker] test skipped: ${reason}`);
      if (fichero !== undefined) registrarSalto(fichero, unavailableCapability);
      skipTest(reason);
    },
  };
}

/**
 * Minimum container contract suites use for the external database.
 *
 * `restart` MUST do something: as a no-op it left the backend-loss cycles of
 * `adversarial-postgres.test.ts` nothing to lose (negative control read `expected true to be
 * false`) and let `real-qa.test.ts` claim `evidence: 'real'` for a restart that never happened.
 * With no postmaster to bounce, killing every backend of that database is the honest emulation.
 */
function contenedorDesacoplado(
  alDetener: () => Promise<void>,
  alReiniciar: () => Promise<void>,
): StartedTestContainer {
  return {
    stop: alDetener, restart: alReiniciar, getHost: () => 'external',
  } as unknown as StartedTestContainer;
}

const PREFIJO_EFIMERA = `${PREFIJO_BASE_DE_PRUEBAS}_e`;
const EDAD_MAXIMA_EFIMERA_MS = 6 * 3_600_000;
const NOMBRE_EFIMERO = new RegExp(`^${PREFIJO_EFIMERA}_p(\\d+)_t([0-9a-z]+)_[0-9a-f]+$`);

export function nombreEfimero(pid: number = process.pid, ahora: number = Date.now()): string {
  const sufijo = randomUUID().replaceAll('-', '').slice(0, 10);
  return `${PREFIJO_EFIMERA}_p${String(pid)}_t${ahora.toString(36)}_${sufijo}`;
}

export function creacionDeBaseEfimera(nombre: string): { creada: number; pid: number } | undefined {
  const partes = NOMBRE_EFIMERO.exec(nombre);
  if (!partes) return undefined;
  return { creada: Number.parseInt(partes[2] ?? '', 36), pid: Number(partes[1]) };
}

export function basesEfimerasCaducadas(
  nombres: string[], ahora: number, edadMaxima: number = EDAD_MAXIMA_EFIMERA_MS,
): string[] {
  return nombres.filter((nombre) => {
    const datos = creacionDeBaseEfimera(nombre);
    return datos !== undefined && ahora - datos.creada > edadMaxima;
  });
}

function urlDeBase(servidor: string, base: string): string {
  const destino = new URL(servidor);
  destino.pathname = `/${base}`;
  return destino.toString();
}

export const nombreDePlantilla = `${PREFIJO_BASE_DE_PRUEBAS}_plantilla`;
const CERROJO_PLANTILLA = 783_003_017;
const HUELLA_IMPRIMIBLE = /^[0-9A-Za-z_.:|-]+$/;

export async function huellaDeMigracionesDelArbol(): Promise<string> {
  const fuentes = [...await migrationSourcesForApply()]
    .sort((una, otra) => una.version.localeCompare(otra.version));
  const digest = createHash('sha256')
    .update(fuentes.map((fuente) => `${fuente.version}:${fuente.sourceSha256}`).join('\n'))
    .digest('hex');
  return `${String(fuentes.length)}:${fuentes.at(-1)?.version ?? '-'}|${digest}`;
}

async function huellaGrabada(sesion: DatabaseClient): Promise<string | undefined> {
  const grabada = await sesion.query<{ huella: string | null }>( // del catálogo, sin conectarse
    `SELECT shobj_description(oid, 'pg_database') AS huella FROM pg_database WHERE datname=$1`,
    [nombreDePlantilla],
  );
  return grabada.rows[0]?.huella ?? undefined;
}

async function sembrarPlantilla(
  url: string, abrirPool: (url: string) => DatabasePool, huella: string,
): Promise<void> {
  const pool = abrirPool(url);
  try {
    await waitForDatabase(pool);
    await applyMigrations(pool);
    await guardarSemillaDeCatalogo(pool);
    const aplicada = await huellaDeMigraciones(pool);
    if (huella.startsWith(`${aplicada}|`)) return;
    throw new Error(
      `la plantilla aplicó "${aplicada}" y el árbol declara "${huella}": el cache se recrearía ` +
        `en cada fichero. Revisá huellaDeMigracionesDelArbol antes de seguir.`,
    );
  } finally {
    await pool.end();
  }
}

export interface OpcionesDePlantilla {
  huellaEsperada?: () => Promise<string>;
  sembrar?: (url: string, huella: string) => Promise<void>;
}

export async function asegurarPlantilla( // una sola vez por servidor, bajo cerrojo de sesión
  servidor: string,
  abrirAdmin: (servidor: string) => DatabasePool = createPool,
  opciones: OpcionesDePlantilla = {},
): Promise<string> {
  const huella = await (opciones.huellaEsperada ?? huellaDeMigracionesDelArbol)();
  if (!HUELLA_IMPRIMIBLE.test(huella)) {
    throw new Error(`huella de migraciones no imprimible, no se cose al SQL: ${huella}`);
  }
  const sembrar = opciones.sembrar
    ?? ((url: string, suya: string): Promise<void> => sembrarPlantilla(url, abrirAdmin, suya));
  const admin = abrirAdmin(servidor);
  await waitForDatabase(admin);
  const sesion = await admin.connect();
  try {
    await sesion.query('SELECT pg_advisory_lock($1)', [CERROJO_PLANTILLA]);
    if (await huellaGrabada(sesion) === huella) return nombreDePlantilla;
    await sesion.query(`DROP DATABASE IF EXISTS ${nombreDePlantilla} WITH (FORCE)`); // cache sucio
    await sesion.query(`CREATE DATABASE ${nombreDePlantilla}`);
    await sembrar(urlDeBase(servidor, nombreDePlantilla), huella);
    await sesion.query(`COMMENT ON DATABASE ${nombreDePlantilla} IS '${huella}'`);
    return nombreDePlantilla;
  } finally {
    await sesion.query('SELECT pg_advisory_unlock($1)', [CERROJO_PLANTILLA])
      .catch(() => undefined);
    sesion.release();
    await admin.end();
  }
}

async function clonarPlantilla(
  admin: DatabasePool, nombre: string, rehacerPlantilla: () => Promise<string>,
): Promise<void> {
  for (let intento = 1; intento <= 5; intento += 1) {
    try {
      await admin.query(`CREATE DATABASE ${nombre} TEMPLATE ${nombreDePlantilla}`);
      return;
    } catch (error) {
      const codigo = errorField(error, 'code');
      if (!['55006', '3D000'].includes(codigo) || intento === 5) throw error;
      if (codigo === '3D000') await rehacerPlantilla(); // otra corrida la tiro fuera del cerrojo
      else await new Promise((resolve) => setTimeout(resolve, intento * 100));
    }
  }
}

/*
 * The database is the isolation unit, not the URL: the migration-integrity suites insert into
 * `schema_migrations` with no ledger entry ON PURPOSE, and one shared database turns that into
 * "applied without an atomic source ledger" for every later file — measured, 49 of 82.
 */
export async function crearBaseEfimera(
  servidor: string,
  abrirAdmin: (servidor: string) => DatabasePool = createPool,
  opciones: { plantilla?: boolean } = {},
): Promise<{ url: string; soltar: () => Promise<void>; tirarConexiones: () => Promise<void> }> {
  const conPlantilla = opciones.plantilla ?? false; // decidido por quien conoce la suite
  if (conPlantilla) await asegurarPlantilla(servidor, abrirAdmin);
  const nombre = nombreEfimero();
  const admin = abrirAdmin(servidor);
  try {
    await waitForDatabase(admin);
    const efimeras = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d WHERE d.datname LIKE $1`,
      [`${PREFIJO_EFIMERA}%`],
    );
    const caducadas = basesEfimerasCaducadas(
      efimeras.rows.map((fila) => fila.datname), Date.now(),
    );
    for (const vieja of caducadas) {
      await admin.query(`DROP DATABASE IF EXISTS ${vieja} WITH (FORCE)`).catch(() => undefined);
    }
    if (conPlantilla) {
      await clonarPlantilla(admin, nombre, () => asegurarPlantilla(servidor, abrirAdmin));
    } else {
      await admin.query(`CREATE DATABASE ${nombre}`);
    }
  } finally {
    await admin.end();
  }
  const soltar = async (): Promise<void> => {
    const limpieza = abrirAdmin(servidor);
    try {
      await limpieza.query(`DROP DATABASE IF EXISTS ${nombre} WITH (FORCE)`);
    } catch {
      // Only the creating process drops it, so a failed teardown leaks until the age sweep.
    } finally {
      await limpieza.end();
    }
  };
  const tirarConexiones = async (): Promise<void> => {
    const admin = abrirAdmin(servidor);
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [nombre],
      );
    } finally {
      await admin.end();
    }
  };
  return { url: urlDeBase(servidor, nombre), soltar, tirarConexiones };
}

export async function startEmptyTestDatabase(serverUrl: string): Promise<EmptyTestDatabase> {
  assertTestDatabaseUrl(serverUrl);
  const { url, soltar } = await crearBaseEfimera(serverUrl, createPool, { plantilla: false });
  const pool = createPool(url, { max: 2 });
  try {
    await waitForDatabase(pool);
    return {
      pool,
      url,
      close: async () => {
        try {
          await pool.end();
        } finally {
          await soltar();
        }
      },
    };
  } catch (error) {
    await pool.end();
    await soltar();
    throw error;
  }
}

export async function startTestDatabase(): Promise<TestDatabase> {
  /*
   * External database support via CAUCE_TEST_DATABASE_URL for environments where the Docker
   * daemon is unavailable for testcontainers.
   */
  const externa = process.env.CAUCE_TEST_DATABASE_URL;
  if (externa) {
    if (process.env.CAUCE_REQUIRE_TESTCONTAINERS === '1') {
      throw new Error('CAUCE_REQUIRE_TESTCONTAINERS=1 rejects the external database fallback');
    }
    assertTestDatabaseUrl(externa);
    const fichero = ficheroDeLaSuite();
    const { url, soltar, tirarConexiones } = await crearBaseEfimera(externa, createPool, {
      plantilla: fichero === undefined || !SUITES_SIN_PLANTILLA.has(fichero),
    });
    const pool = createPool(url);
    try {
      await waitForDatabase(pool);
      await applyMigrations(pool);
      await guardarSemillaDeCatalogo(pool);
      return { container: contenedorDesacoplado(soltar, tirarConexiones), pool, url };
    } catch (error) {
      await pool.end();
      await soltar();
      throw error;
    }
  }

  const password = randomUUID();
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  let builder = new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: 'cauce_test',
      POSTGRES_USER: 'cauce_test',
      POSTGRES_PASSWORD: password
    })
    .withHealthCheck({
      test: ['CMD-SHELL', 'pg_isready -U cauce_test -d cauce_test'],
      interval: 1_000,
      timeout: 3_000,
      retries: 60,
      startPeriod: 1_000
    })
    .withWaitStrategy(Wait.forHealthCheck());
  /*
   * On a shared network the container is reached by its address, so publishing is not just
   * unnecessary: a daemon that does not bind published ports leaves `withExposedPorts` waiting for
   * a binding that never arrives, and the suite dies before the healthy container is ever used.
   */
  builder = network ? builder.withNetworkMode(network) : builder.withExposedPorts(5432);
  const container = await builder.start();
  const host = network ? container.getIpAddress(network) : container.getHost();
  const port = network ? 5432 : container.getMappedPort(5432);
  const url = `postgresql://cauce_test:${encodeURIComponent(password)}@${host}:${String(port)}/cauce_test`;
  const pool = createPool(url);
  try {
    // A healthy container can become visible a few milliseconds before its
    // address is routable on an existing shared Docker network.
    await waitForDatabase(pool);
    await applyMigrations(pool);
    await guardarSemillaDeCatalogo(pool);
    return { container, pool, url };
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }
}

/**
 * Catalog tables: restored from the seed schema on every `resetTestDatabase()` to guarantee
 * isolation and idempotency between test suites.
 */
const TABLAS_DE_CATALOGO = [
  'role_policies',
  'tenants',
  'rooms',
  'memberships',
  'acl_edges',
] as const;

const ESQUEMA_SEMILLA = 'cauce_semilla';
/** Where the fingerprint of the migration set used to capture the seed lives. */
const TABLA_HUELLA = 'huella_de_migraciones';

/**
 * Snapshots the catalog exactly as migrations left it, so it can be restored later.
 *
 * A seed captured under an older migration set is worse than no seed: `restaurarCatalogo()` runs on
 * every reset and would DELETE the catalog row a newer migration just created, failing the suite on
 * something the code does have. The fingerprint of the applied set is stored alongside, and a
 * mismatch THROWS with the drop-and-rerun instruction — re-snapshotting there would enshrine the
 * contaminated state, so it has to be a human decision and never a `catch`.
 */
export async function guardarSemillaDeCatalogo(pool: DatabasePool): Promise<void> {
  const huella = await huellaDeMigraciones(pool);
  const existe = await pool.query<{ hay: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS hay`,
    [ESQUEMA_SEMILLA],
  );
  if (existe.rows[0]?.hay) {
    const guardada = await pool.query<{ huella: string }>(
      `SELECT huella FROM ${ESQUEMA_SEMILLA}.${TABLA_HUELLA}`,
    ).catch(() => ({ rows: [] as { huella: string }[] }));
    const anterior = guardada.rows[0]?.huella;
    if (anterior === huella) return;
    throw new Error(
      `la semilla de catálogo de esta base se guardó con OTRO juego de migraciones ` +
        `(${anterior ?? 'ninguna huella guardada'} vs ${huella}). Restaurarla borraría lo que las ` +
        `migraciones nuevas acaban de sembrar. Tirá el esquema y volvé a correr:\n` +
        `  psql "$CAUCE_TEST_DATABASE_URL" -c 'DROP SCHEMA ${ESQUEMA_SEMILLA} CASCADE'`,
    );
  }
  await pool.query(`CREATE SCHEMA ${ESQUEMA_SEMILLA}`);
  for (const tabla of TABLAS_DE_CATALOGO) {
    await pool.query(`CREATE TABLE ${ESQUEMA_SEMILLA}.${tabla} AS TABLE public.${tabla}`);
  }
  await pool.query(`CREATE TABLE ${ESQUEMA_SEMILLA}.${TABLA_HUELLA}(huella text NOT NULL)`);
  await pool.query(`INSERT INTO ${ESQUEMA_SEMILLA}.${TABLA_HUELLA}(huella) VALUES ($1)`, [huella]);
}

/** Fingerprint of the applied migration set: count and latest version, enough to detect additions. */
export async function huellaDeMigraciones(pool: DatabasePool): Promise<string> {
  const r = await pool.query<{ cuantas: string; ultima: string | null }>(
    `SELECT count(*)::text AS cuantas, max(version) AS ultima FROM schema_migrations`,
  );
  return `${r.rows[0]?.cuantas ?? '0'}:${r.rows[0]?.ultima ?? '-'}`;
}

/** Restores the catalog to the state migrations left it in. */
async function restaurarCatalogo(client: DatabaseClient): Promise<void> {
  const existe = await client.query<{ hay: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS hay`,
    [ESQUEMA_SEMILLA],
  );
  if (!existe.rows[0]?.hay) return;
    // Reverse FK order: parents first, dependents after.
  const alReves = [...TABLAS_DE_CATALOGO].reverse();
  await client.query(`TRUNCATE TABLE ${alReves.join(',')} CASCADE`);
  for (const tabla of TABLAS_DE_CATALOGO) {
    await client.query(`INSERT INTO public.${tabla} SELECT * FROM ${ESQUEMA_SEMILLA}.${tabla}`);
  }
}

export async function resetTestDatabase(pool: DatabasePool): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Catalog restore belongs to the same retryable transaction as the dynamic reset. Keeping
      // it outside this loop let a closing gateway deadlock the first TRUNCATE with no retry and
      // could expose a half-restored catalog between statements.
      await restaurarCatalogo(client);
      // agent_chain_progress has no foreign key by design, so CASCADE cannot reach it.
      // agent_failure_notices and its event ledger are in the same situation (migration 014),
      // and agent_chain_closures too (migration 016, silent-chain watch).
      await client.query(`TRUNCATE TABLE
        dlq_operator_resolutions,telegram_manual_replays,dlq_reconciliation_runs,
        dlq_reconciliation_transitions,
        gateway_oidc_sessions,telegram_egress_effects,channel_bridge_cursors,channel_bridge_leases,
        shadow_compare_verdicts,shadow_human_reply_guards,shadow_router_mappings,shadow_router_inbox,
        egress_notifications,egress_destinations,egress_contacts,
        agent_account_bindings,agents,provider_accounts,
        audit_events,dead_letters,jobs,adapter_outbox,adapter_inbox,delivery_acks,
        delivery_lane_fairness,job_lane_fairness,
        deliveries,idempotency_keys,messages,connection_leases,agent_chain_progress,
        agent_failure_notice_events,agent_failure_notices,agent_chain_closures,
        agent_chain_edge_uses,agent_chain_gates
        RESTART IDENTITY CASCADE`);
      // Same reason the relay flags are pinned here: every suite that does not opt in must see
      // the pre-014 behaviour, so an unrelated test never fails because a sibling failure got
      // coalesced. The suites that exercise the coalescer turn it on themselves.
      //
      // The 019 caps are pinned OFF for the same reason, and more so: they are ON by default in
      // production, so without this pin any suite that delegates multiple times on the same root
      // would start failing on a cap it is not exercising. The delegation-discipline suite turns
      // them on itself with the values it wants to measure.
      await client.query(`UPDATE agent_chain_policies
        SET progress_relay_enabled=false,progress_relay_max_events=12,cycle_cut_enabled=false,
            failure_coalesce_enabled=false,failure_coalesce_window_seconds=900,
            delegation_caps_enabled=false,human_gate_enabled=false,
            max_fanout_per_turn=6,max_edge_repeats_per_root=3,max_delegations_per_root=64`);
      await client.query('COMMIT');
      return;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (!['40P01', '40001'].includes(String(code)) || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    } finally {
      client.release();
    }
  }
}

export async function closeTestDatabase(database?: TestDatabase, pool?: DatabasePool): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
  }
  if (database?.pool && database.pool !== pool) {
    await database.pool.end().catch(() => undefined);
  }
  if (database?.container) {
    await database.container.stop().catch(() => undefined);
  }
}
