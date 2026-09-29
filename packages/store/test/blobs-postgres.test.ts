import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { preparePostgresSuite } from './postgres-suite.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import { grantBlobForDelivery } from '../src/repository/blob-entitlements.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const SHA = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

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

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await applyMigrations(pool);
  await resetTestDatabase(pool);
  await pool.query('DELETE FROM blobs');
});

describe('blobs repository', () => {
  it('registers a blob and reads its metadata back by digest, touching last_used_at', async () => {
    const registered = await repository.registerBlob(blob());
    expect(registered.sha256).toBe(SHA);
    expect(registered.bytes).toBe(1_500_000_000);
    await pool.query(`UPDATE blobs SET last_used_at=now()-interval '2 days' WHERE sha256=$1`, [SHA]);
    const found = await repository.findBlob(SHA, 'Steven', 'kant');
    expect(found?.media_type).toBe('video/mp4');
    expect(found?.name).toBe('demo.mp4');
    expect(found?.tenant_id).toBe('Steven');
    expect(found?.created_by).toBe('zeus');
    expect(Date.now() - (found?.last_used_at.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it('answers nothing for a digest nobody registered', async () => {
    expect(await repository.findBlob(OTHER, 'Steven', 'kant')).toBeUndefined();
  });

  it('is idempotent for the same bytes and refuses a different size under the same digest', async () => {
    const first = await repository.registerBlob(blob());
    const again = await repository.registerBlob(blob({ createdBy: 'argos' }));
    expect(again.created_at.getTime()).toBe(first.created_at.getTime());
    expect(again.created_by).toBe('zeus');
    await expect(repository.registerBlob(blob({ bytes: 7 }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.registerBlob(blob({ bytes: 7 }))).rejects.toBeInstanceOf(StoreError);
  });

  it('does not reveal or touch another tenant\'s blob when reading by digest', async () => {
    await repository.registerBlob(blob());
    await pool.query(`UPDATE blobs SET last_used_at=now()-interval '2 days' WHERE sha256=$1`, [SHA]);
    const before = await pool.query<{ last_used_at: Date }>('SELECT last_used_at FROM blobs WHERE sha256=$1', [SHA]);

    expect(await repository.findBlob(SHA, 'Miguel', 'kratos')).toBeUndefined();

    const after = await pool.query<{ last_used_at: Date }>('SELECT last_used_at FROM blobs WHERE sha256=$1', [SHA]);
    expect(after.rows[0]?.last_used_at).toEqual(before.rows[0]?.last_used_at);
    expect(await repository.findBlob(SHA, 'Steven', 'kant')).toMatchObject({ tenant_id: 'Steven' });
  });

  it('registers equal bytes independently in another tenant without changing owner metadata', async () => {
    const first = await repository.registerBlob(blob());
    const before = await pool.query<{ last_used_at: Date }>('SELECT last_used_at FROM blobs WHERE sha256=$1', [SHA]);
    const foreign = blob({ tenantId: 'Miguel', createdBy: 'atlas', name: 'foreign.mp4' });

    expect(await repository.registerBlob(foreign)).toMatchObject({
      tenant_id: 'Miguel', created_by: 'atlas', name: 'foreign.mp4',
    });

    const after = await pool.query<{ last_used_at: Date }>(
      'SELECT last_used_at FROM blobs WHERE tenant_id=$1 AND sha256=$2', ['Steven', SHA],
    );
    expect(after.rows[0]?.last_used_at).toEqual(before.rows[0]?.last_used_at);
    expect(await repository.findBlob(SHA, 'Steven', 'kant')).toMatchObject({
      tenant_id: first.tenant_id, created_by: first.created_by, name: first.name, bytes: first.bytes,
    });
    expect(await repository.findBlob(SHA, 'Miguel', 'kratos')).toMatchObject({
      tenant_id: 'Miguel', created_by: 'atlas', name: 'foreign.mp4',
    });
  });

  it('lists blobs unused since a cutoff, oldest first, and forgets one', async () => {
    await repository.registerBlob(blob());
    await repository.registerBlob(blob({ sha256: OTHER, name: 'otro.bin', mediaType: 'application/octet-stream' }));
    await pool.query(`UPDATE blobs SET last_used_at=now()-interval '40 days' WHERE sha256=$1`, [SHA]);
    const stale = await repository.staleBlobs(new Date(Date.now() - 30 * 86_400_000), 10);
    expect(stale.map((entry) => entry.sha256)).toEqual([SHA]);
    expect(await repository.forgetBlob(SHA, 'Steven')).toBe(true);
    expect(await repository.forgetBlob(SHA, 'Steven')).toBe(false);
    expect(await repository.findBlob(OTHER, 'Steven', 'kant')).toBeDefined();
  });

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

  it('refuses downgrade while grants or duplicate digests across tenants exist', async () => {
    await repository.registerBlob(blob());
    const deliveryId = await delivery('Miguel', 'kratos');
    await grant({ sha256: SHA, sourceTenant: 'Steven', sourceAlias: 'kant',
      targetTenant: 'Miguel', targetAlias: 'kratos', deliveryId });
    const down = await readFile(new URL('../migrations/down/043_blob_tenant_entitlements.sql', import.meta.url), 'utf8');
    await expect(pool.query(down)).rejects.toThrow(/blob delivery grants exist/u);
    await pool.query('DELETE FROM deliveries WHERE id=$1', [deliveryId]);
    await repository.registerBlob(blob({ tenantId: 'Miguel', createdBy: 'kratos' }));
    await expect(pool.query(down)).rejects.toThrow(/digest belongs to multiple tenants/u);
    expect(await repository.forgetBlob(SHA, 'Miguel')).toBe(true);
    await pool.query(down);
    const key = await pool.query<{ columns: string[] }>(
      `SELECT array_agg(attribute.attname::text ORDER BY key_columns.ordinality) AS columns
       FROM pg_constraint constraint_row
       JOIN unnest(constraint_row.conkey) WITH ORDINALITY AS key_columns(attribute_number,ordinality)
         ON true
       JOIN pg_attribute attribute ON attribute.attrelid=constraint_row.conrelid
         AND attribute.attnum=key_columns.attribute_number
       WHERE constraint_row.conname='blobs_pkey' GROUP BY constraint_row.oid`,
    );
    expect(key.rows[0]?.columns).toEqual(['sha256']);
    await applyMigrations(pool);
  });

  it('can remove 043 and 042, then recreate both tables', async () => {
    const down043 = await readFile(new URL('../migrations/down/043_blob_tenant_entitlements.sql', import.meta.url), 'utf8');
    const down042 = await readFile(new URL('../migrations/down/042_blobs.sql', import.meta.url), 'utf8');
    await pool.query(down043);
    await pool.query(down042);
    const gone = await pool.query<{ relation: string | null }>(`SELECT to_regclass('public.blobs') AS relation`);
    expect(gone.rows[0]?.relation).toBeNull();
    await applyMigrations(pool);
    const back = await pool.query<{ relation: string | null }>(`SELECT to_regclass('public.blobs') AS relation`);
    expect(back.rows[0]?.relation).toBe('blobs');
    const grants = await pool.query<{ relation: string | null }>(
      `SELECT to_regclass('public.blob_delivery_grants') AS relation`,
    );
    expect(grants.rows[0]?.relation).toBe('blob_delivery_grants');
  });
});
