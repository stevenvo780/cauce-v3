import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';

export interface TestDatabase {
  container: StartedTestContainer;
  pool: DatabasePool;
  url: string;
}

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
      if (!['ECONNREFUSED', 'ECONNRESET', '57P03', '08006'].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, attempt * 50)));
    }
  }
  throw lastError;
}

/**
 * El nombre de base que un `CAUCE_TEST_DATABASE_URL` TIENE que llevar para ser aceptado.
 *
 * No es una convención: es lo único que separa «correr la suite» de «truncar producción». Estas
 * pruebas llaman a `resetTestDatabase()`, que hace `TRUNCATE ... CASCADE` sobre 30 tablas. Si
 * alguien exporta por error la URL de la base real, sin esta guarda la suite la vacía y el
 * mensaje de error llegaría DESPUÉS. Por eso la comprobación es sobre el nombre y falla cerrado.
 */
const PREFIJO_BASE_DE_PRUEBAS = 'cauce_test';

/** Extrae el nombre de la base de una URL de postgres, sin traer dependencias. */
export function nombreDeBase(url: string): string {
  const ruta = new URL(url).pathname;
  return ruta.startsWith('/') ? ruta.slice(1) : ruta;
}

/**
 * ¿Esta URL apunta a una base de pruebas desechable?
 *
 * Exportada a propósito para poder probar la guarda sola, con la URL de producción como control
 * negativo. Una guarda que nunca se prueba con el caso que viene a impedir no es una guarda.
 */
export function esBaseDePruebas(url: string): boolean {
  try {
    return nombreDeBase(url).startsWith(PREFIJO_BASE_DE_PRUEBAS);
  } catch {
    return false;
  }
}

export async function startTestDatabase(): Promise<TestDatabase> {
  /*
   * Camino sin Docker. Los contenedores de agente de esta flota NO tienen demonio de Docker
   * dentro (medido el 24-ago-2026: `docker ps` falla en `ws-zeus`), así que toda prueba que
   * dependa de `testcontainers` es IMPOSIBLE de correr desde donde se escribe el código. El
   * resultado práctico era que se escribían pruebas de base y nadie las veía pasar nunca.
   *
   * Con `CAUCE_TEST_DATABASE_URL` la misma suite corre contra una base desechable ya levantada
   * (por ejemplo, una en el VPS alcanzada por un túnel SSH). El contrato de retorno es idéntico;
   * `container` queda con un `stop()` que no hace nada, porque esta suite no la creó y no le
   * toca apagarla.
   */
  const externa = process.env.CAUCE_TEST_DATABASE_URL;
  if (externa) {
    if (!esBaseDePruebas(externa)) {
      throw new Error(
        `CAUCE_TEST_DATABASE_URL apunta a la base "${nombreDeBase(externa)}" y las pruebas ` +
          `TRUNCAN 30 tablas. Sólo se acepta una base cuyo nombre empiece por ` +
          `"${PREFIJO_BASE_DE_PRUEBAS}". Rechazado antes de abrir la conexión.`,
      );
    }
    const pool = createPool(externa);
    try {
      await waitForDatabase(pool);
      await applyMigrations(pool);
      await guardarSemillaDeCatalogo(pool);
      const container = { stop: async () => undefined } as unknown as StartedTestContainer;
      return { container, pool, url: externa };
    } catch (error) {
      await pool.end();
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
    .withExposedPorts(5432)
    .withHealthCheck({
      test: ['CMD-SHELL', 'pg_isready -U cauce_test -d cauce_test'],
      interval: 1_000,
      timeout: 3_000,
      retries: 60,
      startPeriod: 1_000
    })
    .withWaitStrategy(Wait.forHealthCheck());
  if (network) builder = builder.withNetworkMode(network);
  const container = await builder.start();
  const host = network ? container.getIpAddress(network) : container.getHost();
  const port = network ? 5432 : container.getMappedPort(5432);
  const url = `postgresql://cauce_test:${encodeURIComponent(password)}@${host}:${port}/cauce_test`;
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
 * Las tablas de CATÁLOGO: el escenario que dejan las migraciones y del que parte toda suite.
 *
 * `resetTestDatabase()` nunca las truncó —y hacía bien, porque vaciarlas dejaría a cada suite sin
 * inquilinos ni salas—. Pero tampoco las RESTAURABA, así que valían lo que hubiera dejado la
 * última suite que corrió. Medido: la migración 003 siembra `operator(route,read,control)` y en
 * una base compartida llegaba con los tres en falso; y el rol `agent_notify` **no lo crea ninguna
 * migración** —sólo lo nombran los comentarios de la 009—, así que existía únicamente porque otra
 * suite lo había insertado.
 *
 * La consecuencia no es teórica: el mismo código daba 6, 18 o 19 fallos según el orden de las
 * suites. Con los resultados dependiendo de quién corrió antes, ninguna comparación con una línea
 * base significa nada — y en este repo TODO el criterio de «esto ya fallaba» se apoya en esa
 * comparación.
 */
const TABLAS_DE_CATALOGO = [
  'role_policies',
  'tenants',
  'rooms',
  'memberships',
  'acl_edges',
] as const;

const ESQUEMA_SEMILLA = 'cauce_semilla';

/**
 * Guarda el catálogo tal y como lo dejaron las migraciones, para poder devolverlo después.
 *
 * Se hace una vez, justo tras migrar y antes de que ninguna suite toque nada. Es idempotente: si
 * el esquema ya existe —base externa reutilizada— no se rehace, porque rehacerlo copiaría el
 * estado YA contaminado y consagraría el defecto en vez de arreglarlo.
 */
export async function guardarSemillaDeCatalogo(pool: DatabasePool): Promise<void> {
  const existe = await pool.query<{ hay: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS hay`,
    [ESQUEMA_SEMILLA],
  );
  if (existe.rows[0]?.hay) return;
  await pool.query(`CREATE SCHEMA ${ESQUEMA_SEMILLA}`);
  for (const tabla of TABLAS_DE_CATALOGO) {
    await pool.query(`CREATE TABLE ${ESQUEMA_SEMILLA}.${tabla} AS TABLE public.${tabla}`);
  }
}

/** Devuelve el catálogo a como lo dejaron las migraciones. */
async function restaurarCatalogo(pool: DatabasePool): Promise<void> {
  const existe = await pool.query<{ hay: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS hay`,
    [ESQUEMA_SEMILLA],
  );
  if (!existe.rows[0]?.hay) return;
  // En orden inverso al de las dependencias: primero lo que apunta, después lo apuntado.
  const alReves = [...TABLAS_DE_CATALOGO].reverse();
  await pool.query(`TRUNCATE TABLE ${alReves.join(',')} CASCADE`);
  for (const tabla of TABLAS_DE_CATALOGO) {
    await pool.query(`INSERT INTO public.${tabla} SELECT * FROM ${ESQUEMA_SEMILLA}.${tabla}`);
  }
}

export async function resetTestDatabase(pool: DatabasePool): Promise<void> {
  await restaurarCatalogo(pool);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      // agent_chain_progress has no foreign key by design, so CASCADE cannot reach it.
      // agent_failure_notices and its event ledger are in the same situation (migration 014),
      // y agent_chain_closures también (migración 016 del vigía de cadenas mudas).
      await pool.query(`TRUNCATE TABLE
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
      // Los topes de 019 se fijan APAGADOS por el mismo motivo, y con más razón: nacen
      // ENCENDIDOS en producción, así que sin este pin cualquier suite que delegue varias veces
      // sobre la misma raíz empezaría a fallar por un tope que no está probando. La suite de
      // disciplina de delegación los enciende ella misma con los valores que quiere medir.
      await pool.query(`UPDATE agent_chain_policies
        SET progress_relay_enabled=false,progress_relay_max_events=12,cycle_cut_enabled=false,
            failure_coalesce_enabled=false,failure_coalesce_window_seconds=900,
            delegation_caps_enabled=false,human_gate_enabled=false,
            max_fanout_per_turn=6,max_edge_repeats_per_root=3,max_delegations_per_root=64`);
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== '40P01' || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
}
