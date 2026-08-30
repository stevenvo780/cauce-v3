import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Distinction between window-sampled metrics and global database totals.
 *
 * Verifies that `queueSnapshot()` clearly reports the counting universe to avoid ambiguity
 * between window/permission-bounded metrics and global system metrics.
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
 * `resetTestDatabase()` does NOT empty `tenants`, `rooms`, `memberships`, or `acl_edges`: those
 * come from the migration seed and are the shared scenario for all suites. Seeding mine here would
 * have collided with that seed; what I do is make sure it's enabled, like the rest of the store tests.
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
 * Inserts `cuantas` dead deliveries for `Steven:argos`.
 *
 * Publishes through the repository's REAL path and then marks the delivery as dead. Seeding with
 * a manual `INSERT` was my first attempt and it failed: I invented an `idempotency_key` column in
 * `messages` that doesn't exist —it lives in the command, not in the table—. A hand-written
 * fixture goes out of sync with the schema without warning; real publishing can't.
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
      body: { text: `muerta ${String(i)}` },
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
    // 12 dead, but the window is asked for 5: the window's figure CANNOT pass as total.
    await sembrarMuertas(12);

    const snapshot = await repository.queueSnapshot('Steven', 'kant', 5) as {
      dead: number; items: unknown[]; totals?: { dead: number }; muestra_recortada?: boolean;
    };

    expect(snapshot.items.length).toBe(5);
    expect(snapshot.dead).toBeLessThanOrEqual(5);
    // What doesn't exist today and is the whole point: the real total, said separately.
    expect(snapshot.totals?.dead).toBe(12);
    expect(snapshot.muestra_recortada).toBe(true);
  }, 120_000);

  // ── NEGATIVE CONTROL ──────────────────────────────────────────────────────────────────────────

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
     * If the total came from an unfiltered `COUNT(*)`, an operator from one client would see the
     * dead deliveries of another. The global figure has its place —`/v3/status`— and it's not this one.
     */
    await sembrarFlota();
    await sembrarMuertas(4);
    // And one dead delivery from ANOTHER client, which Steven has no reason to count.
    await sembrarMuertas(1, 'Miguel', 'grp.miguel', 'janus', 'janus');

    const snapshot = await repository.queueSnapshot('Steven', 'kant', 200) as { totals?: { dead: number } };
    expect(snapshot.totals?.dead).toBe(4);
  }, 120_000);
});
