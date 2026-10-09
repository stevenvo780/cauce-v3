import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { grantBlobForDelivery } from '../src/repository/blob-entitlements.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

/**
 * Blob grants on the delivery path, against the current schema. The 042/043 migration round trips
 * stay in blobs-postgres.test.ts, pinned to an older schema the current runtime cannot route on.
 */
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;
const SHA = 'c'.repeat(64);
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  repository = new CauceRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function delivery(targetTenant: string, targetAlias: string): Promise<string> {
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES(gen_random_uuid(),'blob-grant-test','Steven','grp.steven','kant','{}','interactive')
     RETURNING id`,
  );
  const created = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
     VALUES($1,$2,$3) RETURNING id`,
    [message.rows[0]?.id, targetTenant, targetAlias],
  );
  const id = created.rows[0]?.id;
  if (id === undefined) throw new Error('delivery was not created');
  return id;
}

async function grant(input: Parameters<typeof grantBlobForDelivery>[1]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await grantBlobForDelivery(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function blob(overrides: Partial<Parameters<CauceRepository['registerBlob']>[0]> = {}) {
  return {
    sha256: SHA, bytes: 1_500_000_000, mediaType: 'video/mp4', name: 'demo.mp4',
    tenantId: 'Steven', createdBy: 'zeus', ...overrides,
  };
}

describe('blob grants on the delivery path', () => {
  it('grants a recipient alias and supports onward delegation without broad tenant access', async () => {
    await repository.registerBlob(blob());
    const toMiguel = await delivery('Miguel', 'kratos');
    const firstGrant = {
      sha256: SHA, sourceTenant: 'Steven', sourceAlias: 'kant',
      targetTenant: 'Miguel', targetAlias: 'kratos', deliveryId: toMiguel,
    };
    expect(await repository.findBlob(SHA, 'Miguel', 'kratos')).toBeUndefined();
    expect(await grant(firstGrant)).toBe(true);
    expect(await grant(firstGrant)).toBe(true);
    expect(await repository.findBlob(SHA, 'Miguel', 'kratos')).toMatchObject({
      tenant_id: 'Steven', name: 'demo.mp4',
    });
    expect(await repository.findBlob(SHA, 'Miguel', 'janus')).toBeUndefined();

    const toPablo = await delivery('Pablo', 'dedalo');
    expect(await grant({ ...firstGrant, sourceTenant: 'Miguel', sourceAlias: 'kratos',
      targetTenant: 'Pablo', targetAlias: 'dedalo', deliveryId: toPablo })).toBe(true);
    expect(await repository.findBlob(SHA, 'Pablo', 'dedalo')).toMatchObject({ tenant_id: 'Steven' });
    expect(await repository.findBlob(SHA, 'Pablo', 'midas')).toBeUndefined();

    const toJhon = await delivery('Jhon', 'hegel');
    expect(await grant({ ...firstGrant, sourceTenant: 'Miguel', sourceAlias: 'janus',
      targetTenant: 'Jhon', targetAlias: 'hegel', deliveryId: toJhon })).toBe(false);
    expect(await grant({ ...firstGrant, targetAlias: 'janus' })).toBe(false);
    expect(await repository.findBlob(SHA, 'Jhon', 'hegel')).toBeUndefined();
    expect(await repository.forgetBlob(SHA, 'Steven')).toBe(false);
    const audits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='blob.grant'`,
    );
    expect(audits.rows[0]?.count).toBe('2');
  });

  it('does not let a hub alias forward one client blob to another client', async () => {
    await repository.registerBlob(blob({ tenantId: 'Isa', createdBy: 'salva', name: 'isa.pdf' }));
    const toKant = await delivery('Steven', 'kant');
    expect(await grant({
      sha256: SHA, sourceTenant: 'Isa', sourceAlias: 'salva',
      targetTenant: 'Steven', targetAlias: 'kant', deliveryId: toKant,
    })).toBe(true);
    const toKratos = await delivery('Miguel', 'kratos');
    expect(await grant({
      sha256: SHA, sourceTenant: 'Steven', sourceAlias: 'kant',
      targetTenant: 'Miguel', targetAlias: 'kratos', deliveryId: toKratos,
    })).toBe(false);
    expect(await repository.findBlob(SHA, 'Miguel', 'kratos')).toBeUndefined();
    expect(await repository.findBlob(SHA, 'Steven', 'kant')).toMatchObject({ sha256: SHA });
  });

  it('rolls back grant and audit with the publishing transaction', async () => {
    await repository.registerBlob(blob());
    const deliveryId = await delivery('Miguel', 'kratos');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await grantBlobForDelivery(client, {
        sha256: SHA, sourceTenant: 'Steven', sourceAlias: 'kant',
        targetTenant: 'Miguel', targetAlias: 'kratos', deliveryId,
      })).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await repository.findBlob(SHA, 'Miguel', 'kratos')).toBeUndefined();
    const audits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events WHERE action='blob.grant'`,
    );
    expect(audits.rows[0]?.count).toBe('0');
  });

  it('does not forward a grant deleted by its source delivery in a concurrent transaction', async () => {
    await repository.registerBlob(blob());
    const sourceDeliveryId = await delivery('Miguel', 'kratos');
    expect(await grant({
      sha256: SHA, sourceTenant: 'Steven', sourceAlias: 'kant',
      targetTenant: 'Miguel', targetAlias: 'kratos', deliveryId: sourceDeliveryId,
    })).toBe(true);
    const targetDeliveryId = await delivery('Pablo', 'dedalo');
    const deleter = await pool.connect();
    const forwarder = await pool.connect();
    let forwarding: Promise<boolean> | undefined;
    try {
      await deleter.query('BEGIN');
      await deleter.query('DELETE FROM deliveries WHERE id=$1', [sourceDeliveryId]);
      await forwarder.query('BEGIN');
      await forwarder.query(`SET LOCAL lock_timeout='5s'`);
      const pid = await forwarder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      forwarding = grantBlobForDelivery(forwarder, {
        sha256: SHA, sourceTenant: 'Miguel', sourceAlias: 'kratos',
        targetTenant: 'Pablo', targetAlias: 'dedalo', deliveryId: targetDeliveryId,
      });
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`,
          [pid.rows[0]?.pid],
        );
        if (state.rows[0]?.waiting === true) {
          blocked = true;
          break;
        }
        await delay(20);
      }
      await deleter.query('COMMIT');
      expect(blocked).toBe(true);
      expect(await forwarding).toBe(false);
      await forwarder.query('COMMIT');
      expect(await repository.findBlob(SHA, 'Pablo', 'dedalo')).toBeUndefined();
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      await forwarder.query('ROLLBACK').catch(() => undefined);
      await forwarding?.catch(() => undefined);
      deleter.release();
      forwarder.release();
    }
  });
});
