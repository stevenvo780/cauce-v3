import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Distinción entre métricas muestreadas por ventana y totales globales de la base.
 *
 * Verifica que `queueSnapshot()` reporte claramente el universo de conteo para evitar
 * ambigüedad entre métricas acotadas por ventana/permisos y métricas globales del sistema.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

/*
 * `resetTestDatabase()` NO vacía `tenants`, `rooms`, `memberships` ni `acl_edges`: esos salen de
 * la semilla de las migraciones y son el escenario compartido de todas las suites. Sembrar aquí
 * los míos habría chocado con esa semilla; lo que hago es asegurarme de que está encendida, igual
 * que el resto de las pruebas del store.
 */
async function sembrarFlota(): Promise<void> {
  await pool.query(`
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
  `);
}

/**
 * Mete `cuantas` entregas muertas para `Steven:argos`.
 *
 * Publica por el camino REAL del repositorio y después marca la entrega como muerta. Sembrar con
 * `INSERT` a mano fue mi primer intento y falló: inventé una columna `idempotency_key` en
 * `messages` que no existe —vive en el comando, no en la tabla—. Un fixture escrito a mano se
 * desincroniza del esquema sin avisar; publicar de verdad no puede.
 */
async function sembrarMuertas(cuantas: number, tenant = 'Steven', room = 'grp.steven', emisor = 'kant', destino = 'argos'): Promise<void> {
  for (let i = 0; i < cuantas; i += 1) {
    const publicado = await repository.publish({
      version: '3.0',
      request_id: randomUUID(),
      trace_id: `trace-${randomUUID()}`,
      tenant_id: tenant,
      room_id: room,
      actor_alias: emisor,
      recipients: [{ tenant_id: tenant, alias: destino }],
      body: { text: `muerta ${i}` },
      idempotency_key: randomUUID(),
      lane: 'batch',
      priority: 0,
    });
    await pool.query(
      `UPDATE deliveries SET status='dead' WHERE message_id=$1`,
      [publicado.message_id],
    );
  }
}

describe('la muestra de colas no se puede confundir con el total', () => {
  it('declara el total REAL además del contado en la ventana', async () => {
    await sembrarFlota();
    // 12 muertas, pero la ventana se pide de 5: la cifra de la ventana NO puede pasar por total.
    await sembrarMuertas(12);

    const snapshot = await repository.queueSnapshot('Steven', 'kant', 5) as {
      dead: number; items: unknown[]; totals?: { dead: number }; muestra_recortada?: boolean;
    };

    expect(snapshot.items.length).toBe(5);
    expect(snapshot.dead).toBeLessThanOrEqual(5);
    // Lo que hoy no existe y es todo el punto: el total de verdad, dicho aparte.
    expect(snapshot.totals?.dead).toBe(12);
    expect(snapshot.muestra_recortada).toBe(true);
  }, 120_000);

  // ── CONTROL NEGATIVO ──────────────────────────────────────────────────────────────────────

  it('CONTROL NEGATIVO: cuando la ventana alcanza, NO se declara recortada y los números coinciden', async () => {
    await sembrarFlota();
    await sembrarMuertas(3);

    const snapshot = await repository.queueSnapshot('Steven', 'kant', 200) as {
      dead: number; totals?: { dead: number }; muestra_recortada?: boolean;
    };

    expect(snapshot.dead).toBe(3);
    expect(snapshot.totals?.dead).toBe(3);
    expect(snapshot.muestra_recortada).toBe(false);
  }, 120_000);

  it('CONTROL NEGATIVO: el total respeta lo que el actor puede ver, no es un COUNT global', async () => {
    /*
     * Si el total saliera de un `COUNT(*)` sin filtro, un operador de un cliente vería las
     * entregas muertas de otro. La cifra global tiene su sitio —`/v3/status`— y no es ésta.
     */
    await sembrarFlota();
    await sembrarMuertas(4);
    // Y una muerta de OTRO cliente, que Steven no tiene por qué contar.
    await sembrarMuertas(1, 'Miguel', 'grp.miguel', 'janus', 'janus');

    const snapshot = await repository.queueSnapshot('Steven', 'kant', 200) as { totals?: { dead: number } };
    expect(snapshot.totals?.dead).toBe(4);
  }, 120_000);
});
